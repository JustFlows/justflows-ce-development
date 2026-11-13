import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../database/db.js";
import { isDuplicateKeyError } from "./plugin-row-sql.js";
import { getJfRoot } from "../runtime/jf-root.js";
import { runAllMigrations } from "../database/run-migrations.js";
import { getSiteId } from "../themes/themes-db.js";

export interface PluginRow {
  id: string;
  site_id: string;
  plugin_id: string;
  version: string;
  status: "installed" | "active" | "inactive" | "error";
  manifest: Record<string, unknown>;
  approved_permissions: string[];
  safe_mode: boolean;
  installed_at: string;
  activated_at: string | null;
  updated_at: string;
}

export interface PluginDto {
  id: string;
  plugin_id: string;
  name: string;
  version: string;
  description?: string;
  publisher: string;
  status: PluginRow["status"];
  settingsSchema?: Record<string, {
    type: string;
    label: string;
    description?: string;
    default?: unknown;
    localized?: boolean;
    options?: Array<{ value: string; label: string }>;
    optionsSource?: "timezones" | "countries";
  }>;
  setupPath?: string;
  /** The package allows the main site to offer it to other sites. */
  allowMultisite?: boolean;
  /** The main site has turned that offer on. */
  multisiteEnabled?: boolean;
}

export function pluginsDir(): string {
  const rel = process.env.PLUGINS_DIR ?? "plugins";
  return path.isAbsolute(rel) ? rel : path.join(getJfRoot(), rel);
}

export async function ensurePluginsTable(): Promise<void> {
  const db = await getDb();
  const driver = process.env.DB_DRIVER as "postgres" | "mysql" | "mariadb";
  await runAllMigrations(db, driver);
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parsePluginRow(row: PluginRow): PluginRow {
  return {
    ...row,
    manifest:
      typeof row.manifest === "string"
        ? JSON.parse(row.manifest)
        : row.manifest ?? {},
    approved_permissions:
      typeof row.approved_permissions === "string"
        ? JSON.parse(row.approved_permissions)
        : row.approved_permissions ?? [],
  };
}

function nonemptySettingsSchema(value: unknown): PluginDto["settingsSchema"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (Object.keys(value).length === 0) return undefined;
  return value as NonNullable<PluginDto["settingsSchema"]>;
}

let liveSettingsSchemaLookup: ((pluginId: string) => PluginDto["settingsSchema"]) | undefined;

/** Used by the plugin runtime so Admin can read `settingsSchema` from the loaded module. */
export function setLivePluginSettingsSchemaLookup(
  fn: ((pluginId: string) => PluginDto["settingsSchema"]) | undefined,
): void {
  liveSettingsSchemaLookup = fn;
}

function readSettingsSchemaFromDisk(manifest: Record<string, unknown>): PluginDto["settingsSchema"] {
  const basePath =
    (typeof manifest.installedPath === "string" && manifest.installedPath) ||
    (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
    null;
  if (!basePath) return undefined;

  const manifestPath = path.join(basePath, "justflows.json");
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    return nonemptySettingsSchema(raw.settingsSchema);
  } catch {
    return undefined;
  }
}

/** A plugin's settings schema as the settings page resolves it, or undefined when it has none. */
export function resolvePluginSettingsSchema(
  pluginId: string,
  manifest: Record<string, unknown>,
): PluginDto["settingsSchema"] {
  return pickSettingsSchema(pluginId, manifest, liveSettingsSchemaLookup?.(pluginId));
}

/** The live module, then justflows.json, then the stored row. */
export function pickSettingsSchema(
  _pluginId: string,
  manifest: Record<string, unknown>,
  live?: PluginDto["settingsSchema"],
): PluginDto["settingsSchema"] {
  return (
    nonemptySettingsSchema(live) ??
    nonemptySettingsSchema(readSettingsSchemaFromDisk(manifest)) ??
    nonemptySettingsSchema(manifest.settingsSchema)
  );
}

function setupPathFromManifest(manifest: Record<string, unknown>): string | undefined {
  const candidates = [manifest.setupPath];
  const basePath =
    (typeof manifest.installedPath === "string" && manifest.installedPath) ||
    (typeof manifest.bundledPath === "string" && manifest.bundledPath) ||
    null;
  if (basePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(basePath, "justflows.json"), "utf8")) as Record<
        string,
        unknown
      >;
      candidates.push(raw.setupPath);
    } catch {
      // Disk manifest is optional; the stored row is enough for a fresh install.
    }
  }
  for (const raw of candidates) {
    if (typeof raw === "string" && /^\/admin\/[a-z0-9][a-z0-9\-/]*$/.test(raw)) return raw;
  }
  return undefined;
}

export function pluginToDto(row: PluginRow): PluginDto {
  const manifest = row.manifest ?? {};
  // Live package on disk (and the loaded module) win over a stale row so a
  // plugin can add settings fields without a reinstall. First-party fallbacks
  // still cover old bundled packages that never shipped a settingsSchema file.
  const settingsSchema = pickSettingsSchema(
    row.plugin_id,
    manifest,
    liveSettingsSchemaLookup?.(row.plugin_id),
  );
  return {
    id: row.plugin_id,
    plugin_id: row.plugin_id,
    name: String(manifest.name ?? humanizeSlug(row.plugin_id.split(".").pop() ?? row.plugin_id)),
    version: row.version,
    description: typeof manifest.description === "string" ? manifest.description : undefined,
    publisher: String(manifest.publisher ?? manifest.author ?? "Justflows"),
    status: row.status,
    settingsSchema,
    setupPath: setupPathFromManifest(manifest),
    allowMultisite: manifest.allowMultisite === true,
  };
}

function readBundledManifest(pluginPath: string, folderName: string): Record<string, unknown> | null {
  for (const file of ["justflows.json", "justflows-plugin.json", "package.json"]) {
    const manifestPath = path.join(pluginPath, file);
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (file === "package.json") {
        const pluginId = typeof raw.name === "string" ? raw.name : folderName;
        return {
          schemaVersion: 1,
          type: "plugin",
          id: pluginId,
          name: humanizeSlug(folderName),
          version: typeof raw.version === "string" ? raw.version : "1.0.0",
          publisher: "Justflows",
          description: typeof raw.description === "string" ? raw.description : undefined,
          permissions: [],
          bundledPath: pluginPath,
        };
      }

      return {
        ...raw,
        bundledPath: pluginPath,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/** Two plugin-list requests can both miss the row and insert the same plugin. */
function isBundledPluginConflict(err: unknown): boolean {
  if (isDuplicateKeyError(err)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return code === "23505";
}

/** Register bundled plugins from the plugins/ directory when missing from the DB. */
export async function syncBundledPlugins(siteId: string): Promise<void> {
  const dir = pluginsDir();
  if (!fs.existsSync(dir)) return;

  const db = await getDb();
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const pluginPath = path.join(dir, entry.name);
    const manifest = readBundledManifest(pluginPath, entry.name);
    if (!manifest) continue;

    const pluginId = String(manifest.id ?? entry.name);
    const existingRows = await db.query<PluginRow>(
      "SELECT * FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
      [siteId, pluginId],
    );
    const existing = existingRows[0] ? parsePluginRow(existingRows[0]) : null;
    if (existing) {
      // An uploaded .jfpkg owns installedPath; do not replace it with the
      // developer checkout copy. Bundled rows refresh so settingsSchema and
      // adminMenu added after the first sync are not stuck on the old JSON.
      if (typeof existing.manifest.installedPath === "string" && existing.manifest.installedPath) {
        continue;
      }
      // package.json stubs have no settingsSchema; only refresh from justflows.json.
      if (!fs.existsSync(path.join(pluginPath, "justflows.json"))) continue;
      await db.run(
        `UPDATE plugins SET version = ?, manifest = ?, updated_at = ? WHERE site_id = ? AND plugin_id = ?`,
        [String(manifest.version ?? existing.version), JSON.stringify(manifest), now(), siteId, pluginId],
      );
      continue;
    }

    try {
      await db.run(
        `INSERT INTO plugins
           (id, site_id, plugin_id, version, status, manifest, approved_permissions, safe_mode, installed_at, updated_at)
         VALUES (?, ?, ?, ?, 'inactive', ?, ?, FALSE, ?, ?)`,
        [
          randomUUID(),
          siteId,
          pluginId,
          String(manifest.version ?? "1.0.0"),
          JSON.stringify(manifest),
          JSON.stringify([]),
          now(),
          now(),
        ],
      );
    } catch (err) {
      if (!isBundledPluginConflict(err)) throw err;
    }
  }
}

export async function listPlugins(siteId: string): Promise<PluginDto[]> {
  await syncBundledPlugins(siteId);
  const db = await getDb();
  const rows = await db.query<PluginRow>(
    "SELECT * FROM plugins WHERE site_id = ? ORDER BY installed_at DESC",
    [siteId],
  );
  return rows.map((row) => pluginToDto(parsePluginRow(row)));
}

export async function insertPlugin(
  siteId: string,
  plugin: {
    pluginId: string;
    version: string;
    manifest: Record<string, unknown>;
    status?: PluginRow["status"];
  },
): Promise<PluginDto> {
  const db = await getDb();
  const existing = await getPlugin(siteId, plugin.pluginId);
  if (!existing && plugin.status === "active") {
    const { enforceQuota, QuotaRefusalError } = await import("../tenancy/quotas.js");
    const quota = await enforceQuota("plugins", siteId, 1);
    if (quota) throw new QuotaRefusalError(quota);
  }
  const status = existing?.status ?? plugin.status ?? "installed";
  const stamp = now();

  if (existing) {
    await db.run(
      `UPDATE plugins SET version = ?, manifest = ?, updated_at = ? WHERE site_id = ? AND plugin_id = ?`,
      [plugin.version, JSON.stringify(plugin.manifest), stamp, siteId, plugin.pluginId],
    );
    await forgetMainSitePlugins();
    return pluginToDto(
      parsePluginRow({
        ...existing,
        version: plugin.version,
        manifest: plugin.manifest,
        status,
        updated_at: stamp,
      }),
    );
  }

  const id = randomUUID();
  await db.run(
    `INSERT INTO plugins
       (id, site_id, plugin_id, version, status, manifest, approved_permissions, safe_mode, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)`,
    [
      id,
      siteId,
      plugin.pluginId,
      plugin.version,
      status,
      JSON.stringify(plugin.manifest),
      JSON.stringify([]),
      stamp,
      stamp,
    ],
  );
  await forgetMainSitePlugins();

  return pluginToDto(
    parsePluginRow({
      id,
      site_id: siteId,
      plugin_id: plugin.pluginId,
      version: plugin.version,
      status,
      manifest: plugin.manifest,
      approved_permissions: [],
      safe_mode: false,
      installed_at: stamp,
      activated_at: null,
      updated_at: stamp,
    }),
  );
}

/** Overlay public manifest fields from the loaded module without dropping install paths. */
export async function mergeLoadedPluginManifest(
  siteId: string,
  pluginId: string,
  loaded: Record<string, unknown>,
): Promise<void> {
  const existing = await getPlugin(siteId, pluginId);
  if (!existing) return;
  const manifest: Record<string, unknown> = { ...existing.manifest, ...loaded };
  if (typeof existing.manifest.installedPath === "string") {
    manifest.installedPath = existing.manifest.installedPath;
  }
  if (typeof existing.manifest.bundledPath === "string") {
    manifest.bundledPath = existing.manifest.bundledPath;
  }
  const version = typeof loaded.version === "string" ? loaded.version : existing.version;
  const db = await getDb();
  await db.run(
    `UPDATE plugins SET version = ?, manifest = ?, updated_at = ? WHERE site_id = ? AND plugin_id = ?`,
    [version, JSON.stringify(manifest), now(), siteId, pluginId],
  );
  await forgetMainSitePlugins();
}

export async function getPlugin(siteId: string, pluginId: string): Promise<PluginRow | null> {
  const db = await getDb();
  const rows = await db.query<PluginRow>(
    "SELECT * FROM plugins WHERE site_id = ? AND plugin_id = ? LIMIT 1",
    [siteId, pluginId],
  );
  return rows[0] ? parsePluginRow(rows[0]) : null;
}

/**
 * Network handlers follow the main site's active plugins, and other sites load
 * the main site's manifests; drop both cached lists on any change.
 */
async function forgetMainSitePlugins(): Promise<void> {
  const { clearMainSitePluginCache } = await import("./plugin-network.js");
  clearMainSitePluginCache();
  const { clearRootPluginCache } = await import("./plugin-root-manifest.js");
  clearRootPluginCache();
}

export async function activatePlugin(siteId: string, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    "UPDATE plugins SET status = 'active', activated_at = ?, updated_at = ? WHERE site_id = ? AND plugin_id = ?",
    [now(), now(), siteId, pluginId],
  );
  await forgetMainSitePlugins();
}

export async function deactivatePlugin(siteId: string, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    "UPDATE plugins SET status = 'inactive', updated_at = ? WHERE site_id = ? AND plugin_id = ?",
    [now(), siteId, pluginId],
  );
  await forgetMainSitePlugins();
}

/** Mark a plugin's runtime activation as failed so the admin surface can show why. */
export async function markPluginError(siteId: string, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.run(
    "UPDATE plugins SET status = 'error', updated_at = ? WHERE site_id = ? AND plugin_id = ?",
    [now(), siteId, pluginId],
  );
  await forgetMainSitePlugins();
}

export async function deletePlugin(siteId: string, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.run("DELETE FROM plugins WHERE site_id = ? AND plugin_id = ?", [siteId, pluginId]);
  await forgetMainSitePlugins();
}

export async function getPluginsSiteId(): Promise<string | null> {
  await ensurePluginsTable();
  return getSiteId();
}
