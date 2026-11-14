// SPDX-License-Identifier: MIT

import { BLOCK_TYPE_RE as BLOCK_TYPE_PATTERN } from "@justflows/sdk";

/**
 * The editor contract a block definition may declare (justflows-ce#305):
 * everything the builder needs to insert, preview, edit, migrate and lay out
 * a plugin or theme block through public APIs only.
 *
 * Every field is optional and bounded. `normalizeBlockContract` keeps only
 * well-formed values and rejects what would leave a block broken
 * (an unsupported `apiVersion`, an incomplete migration chain); it never
 * lets a definition change how the host sanitizes, authorizes, or stores
 * documents. Those stay on the host side whatever a definition says.
 */

/** The contract version this host implements. */
export const BLOCK_API_VERSION = 1;
/** Contract versions this host accepts. A newer one is refused with a clear error. */
export const SUPPORTED_BLOCK_API_VERSIONS: readonly number[] = [1];

/** `parents` value for a region root (page body, header slot, footer, template). */
export const ROOT_PARENT_KEYWORD = "$root";

export interface BlockDeprecation {
  /** Plugin or theme version that deprecated the block. */
  since: string;
  /** A block type that replaces it, shown to authors. */
  replacedBy?: string;
  message?: string;
}

/** A one-click change to a selected block: merges `props`, which the host validates like any edit. */
export interface BlockAction {
  id: string;
  label: string;
  props: Record<string, unknown>;
  /** Also show as a button on the block's canvas toolbar. */
  toolbar?: boolean;
}

export interface BlockPreviewContract {
  /**
   * `server` (default): the builder shows the block's own `render` output,
   * sanitized. `placeholder`: the builder shows the title, description and
   * icon without calling `render`, for blocks that need live request data.
   */
  mode?: "server" | "placeholder";
  /** Props merged under the block's own when previewing, so empty or data-bound blocks look real. */
  sampleProps?: Record<string, unknown>;
  /** Minimum preview height in CSS pixels, so layout does not jump while loading. */
  minHeight?: number;
}

export interface BlockSupports {
  /**
   * Accept the host's `containerLayout` (row, column, grid). `target` is the
   * class of the element holding the children; omitted means the root.
   */
  containerLayout?: boolean | { target?: string };
}

export interface BlockMigrationStep {
  from: number;
  to: number;
  migrate(props: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

/** The contract fields of a definition, after normalization. */
export interface BlockContract {
  apiVersion: number;
  keywords: string[];
  /** Parent types this block may be placed in; `$root` means a region root. Empty means anywhere its parent allows. */
  parents: string[];
  defaults?: Record<string, unknown>;
  deprecated?: BlockDeprecation;
  actions: BlockAction[];
  preview: Required<Pick<BlockPreviewContract, "mode">> & Omit<BlockPreviewContract, "mode">;
  supports: { containerLayout: false | { target: string | null } };
  migrations: BlockMigrationStep[];
}

export class BlockContractError extends Error {}

const LIMITS = { keywords: 12, keyword: 40, parents: 24, actions: 8, label: 60, json: 8_192, minHeight: 2_000 };
const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const CSS_CLASS = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function plain(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A plain JSON object no larger than the limit, or undefined. Functions, cycles and huge values are refused. */
function boundedObject(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  try {
    const text = JSON.stringify(raw);
    if (!text || text.length > LIMITS.json) return undefined;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a definition's contract fields. Throws `BlockContractError` for
 * values that would leave the block unusable; drops anything else malformed.
 */
export function normalizeBlockContract(def: Record<string, unknown>): BlockContract {
  const type = typeof def["type"] === "string" ? def["type"] : "";
  const version = typeof def["version"] === "number" && Number.isInteger(def["version"]) && def["version"] >= 1 ? def["version"] : 1;

  const apiVersion = def["apiVersion"] === undefined ? BLOCK_API_VERSION : def["apiVersion"];
  if (typeof apiVersion !== "number" || !SUPPORTED_BLOCK_API_VERSIONS.includes(apiVersion)) {
    throw new BlockContractError(
      `Block "${type}" declares apiVersion ${String(apiVersion)}; this Justflows supports ${SUPPORTED_BLOCK_API_VERSIONS.join(", ")}. Update Justflows or the extension.`,
    );
  }

  const keywords = Array.isArray(def["keywords"])
    ? [...new Set((def["keywords"] as unknown[]).map((k) => plain(k, LIMITS.keyword).toLowerCase()).filter(Boolean))].slice(0, LIMITS.keywords)
    : [];

  const parents = Array.isArray(def["parents"])
    ? [...new Set((def["parents"] as unknown[]).filter((p): p is string => typeof p === "string" && (p === ROOT_PARENT_KEYWORD || BLOCK_TYPE_PATTERN.test(p))))].slice(0, LIMITS.parents)
    : [];

  const defaults = boundedObject(def["defaults"]);

  let deprecated: BlockDeprecation | undefined;
  const rawDeprecated = def["deprecated"];
  if (rawDeprecated && typeof rawDeprecated === "object") {
    const d = rawDeprecated as Record<string, unknown>;
    deprecated = { since: plain(d["since"], 40) || "unknown" };
    if (typeof d["replacedBy"] === "string" && BLOCK_TYPE_PATTERN.test(d["replacedBy"])) deprecated.replacedBy = d["replacedBy"];
    const message = plain(d["message"], 200);
    if (message) deprecated.message = message;
  } else if (rawDeprecated === true) {
    deprecated = { since: "unknown" };
  }

  const actions: BlockAction[] = [];
  for (const raw of Array.isArray(def["actions"]) ? (def["actions"] as unknown[]) : []) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = typeof a["id"] === "string" && ACTION_ID.test(a["id"]) ? a["id"] : "";
    const label = plain(a["label"], LIMITS.label);
    const props = boundedObject(a["props"]);
    if (!id || !label || !props || actions.some((x) => x.id === id)) continue;
    actions.push({ id, label, props, ...(a["toolbar"] === true ? { toolbar: true } : {}) });
    if (actions.length >= LIMITS.actions) break;
  }

  const rawPreview = (def["preview"] && typeof def["preview"] === "object" ? def["preview"] : {}) as Record<string, unknown>;
  const preview: BlockContract["preview"] = { mode: rawPreview["mode"] === "placeholder" ? "placeholder" : "server" };
  const sampleProps = boundedObject(rawPreview["sampleProps"]);
  if (sampleProps) preview.sampleProps = sampleProps;
  if (typeof rawPreview["minHeight"] === "number" && rawPreview["minHeight"] > 0) {
    preview.minHeight = Math.min(LIMITS.minHeight, Math.round(rawPreview["minHeight"]));
  }

  const rawSupports = (def["supports"] && typeof def["supports"] === "object" ? def["supports"] : {}) as Record<string, unknown>;
  const rawLayout = rawSupports["containerLayout"];
  let containerLayout: BlockContract["supports"]["containerLayout"] = false;
  if (rawLayout === true) containerLayout = { target: null };
  else if (rawLayout && typeof rawLayout === "object") {
    const target = (rawLayout as Record<string, unknown>)["target"];
    containerLayout = { target: typeof target === "string" && CSS_CLASS.test(target) ? target : null };
  }
  if (containerLayout && def["supportsChildren"] !== true) containerLayout = false;

  const migrations: BlockMigrationStep[] = [];
  const rawMigrations = Array.isArray(def["migrations"]) ? (def["migrations"] as unknown[]) : [];
  for (const raw of rawMigrations) {
    const m = raw as Partial<BlockMigrationStep> | null;
    if (!m || typeof m.migrate !== "function" || !Number.isInteger(m.from) || m.to !== (m.from as number) + 1) {
      throw new BlockContractError(`Block "${type}" has a migration that is not a function from version N to N + 1`);
    }
    migrations.push({ from: m.from as number, to: m.to, migrate: m.migrate });
  }
  if (migrations.length) {
    const froms = new Set(migrations.map((m) => m.from));
    for (let v = 1; v < version; v++) {
      if (!froms.has(v)) {
        throw new BlockContractError(`Block "${type}" is at version ${version} but has no migration from version ${v}`);
      }
    }
    if (Math.max(...migrations.map((m) => m.to)) !== version) {
      throw new BlockContractError(`Block "${type}" is at version ${version}, but its migrations end at another version`);
    }
  }

  return { apiVersion, keywords, parents, ...(defaults ? { defaults } : {}), ...(deprecated ? { deprecated } : {}), actions, preview, supports: { containerLayout }, migrations };
}
