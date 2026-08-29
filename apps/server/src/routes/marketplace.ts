// SPDX-License-Identifier: MIT

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { assertPackageIsTrusted } from "../lib/package-trust.js";
import { sendPackageInstallError } from "../lib/package-install-error.js";
import { packagesInstalledDir } from "../lib/packages-dir.js";
import { ARCHIVE_LIMITS } from "@justflows/installer";
import { filterMarketplaceCatalogBody, marketplaceListingIsComingSoon, marketplaceListingIsPaid, marketplaceListingIsVisible } from "../lib/marketplace-catalog.js";

const router = Router();

const JUSTFLOWS_API_BASE = "https://api.justflows.com";

/**
 * A registry that hangs or answers forever is still a dependency failure.
 * Without a deadline the request thread stalled indefinitely, and
 * `await download.arrayBuffer()` buffered the whole body before the installer's
 * 50 MB limit could apply — so the ceiling only ever ran after the memory had
 * already been spent.
 */
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Read a response body, aborting once it exceeds `maxBytes`. */
async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Package exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  // Streamed rather than trusting Content-Length, which a hostile or broken
  // registry can understate or omit entirely.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Package exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

router.get("/", requireRole("administrator"), async (req, res) => {
  try {
    const params = new URLSearchParams();
    for (const key of ["q", "category", "channel", "compatibleWith", "type"] as const) {
      const value = req.query[key];
      if (typeof value === "string" && value) params.set(key, value);
    }
    const qs = params.toString();
    const url = `${JUSTFLOWS_API_BASE}/v1/marketplace${qs ? `?${qs}` : ""}`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const body = await upstream.text();
    // Always JSON. Echoing the upstream Content-Type would let a compromised or
    // misconfigured registry serve text/html from this site's origin.
    res.status(upstream.status).type("application/json").send(
      upstream.ok ? filterMarketplaceCatalogBody(body) : body,
    );
  } catch (err) {
    res.status(503).json({ error: `Marketplace API unavailable: ${String(err)}` });
  }
});

const InstallSchema = z.object({
  type: z.enum(["plugin", "theme"]),
  id: z.string().min(1),
  version: z.string().optional(),
});

router.post("/install", requireRole("administrator"), async (req, res) => {
  try {
    const { type, id, version } = InstallSchema.parse(req.body);
    const versionSegment = version ? `/versions/${encodeURIComponent(version)}` : "/versions/latest";
    const kind = type === "plugin" ? "plugins" : "themes";
    const metaUrl = `${JUSTFLOWS_API_BASE}/v1/marketplace/${kind}/${encodeURIComponent(id)}${versionSegment}`;
    const metaRes = await fetch(metaUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!metaRes.ok) {
      res.status(metaRes.status).json({ error: `Listing not found (${id})` });
      return;
    }
    const listing = (await metaRes.json()) as {
      version?: string;
      channel?: string;
      pricing?: { type?: string };
      registry?: {
        listed?: boolean;
        free?: boolean;
        commercialMarketplace?: boolean;
        comingSoon?: boolean;
      };
    };

    if (!marketplaceListingIsVisible(listing)) {
      res.status(404).json({ error: `Listing not found (${id})` });
      return;
    }

    if (marketplaceListingIsComingSoon(listing)) {
      res.status(403).json({ error: "This listing is coming soon and cannot be installed yet." });
      return;
    }

    if (marketplaceListingIsPaid(listing)) {
      res.status(402).json({
        error: "This listing is commercial. Get it on Justflows.",
        checkoutUrl: "https://justflows.com/marketplace",
      });
      return;
    }

    const resolvedVersion = version ?? listing.version;
    if (!resolvedVersion) {
      res.status(400).json({ error: "Version is required" });
      return;
    }

    // Always download via the public API. Registry downloadUrl is an internal
    // path (e.g. /v1/plugins/...) which Node fetch cannot resolve.
    const downloadUrl = `${JUSTFLOWS_API_BASE}/v1/marketplace/${kind}/${encodeURIComponent(id)}/versions/${encodeURIComponent(resolvedVersion)}/download`;
    const download = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!download.ok) {
      res.status(download.status).json({ error: "Download failed" });
      return;
    }

    const buffer = await readBounded(download, ARCHIVE_LIMITS.maxCompressedBytes);
    const digest = download.headers.get("x-justflows-digest") ?? "";
    const signature = download.headers.get("x-justflows-signature") ?? "";

    const { PackageInstaller } = await import("@justflows/installer");
    const installer = new PackageInstaller();
    const packagesDir = packagesInstalledDir();
    // Verified inside the installer, while the package is still staged — see
    // the note on InstallOptions.verify.
    const result = await installer.installFromBuffer(buffer, {
      packagesDir,
      source: "marketplace",
      expectedDigest: digest || undefined,
      verify: (manifest, resultDigest) => {
        if (manifest.type !== type) {
          throw new Error(`Package type mismatch (expected ${type})`);
        }
        assertPackageIsTrusted(manifest as unknown as Record<string, unknown>, resultDigest, {
          marketplaceSignature: signature || undefined,
        });
      },
    });

    if (type === "plugin") {
      const { insertPlugin } = await import("../lib/plugins-db.js");
      const siteId = req.session?.siteId;
      if (!siteId) {
        res.status(503).json({ error: "No site found — complete install first" });
        return;
      }
      const plugin = await insertPlugin(siteId, {
        pluginId: result.manifest.id,
        version: result.manifest.version,
        manifest: { ...result.manifest, installedPath: result.installedPath },
        status: "installed",
      });
      res.json({ plugin });
      return;
    }

    const { ensureThemesTable, getSiteId, insertTheme } = await import("../lib/themes-db.js");
    await ensureThemesTable();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found — complete install first" });
      return;
    }
    const manifest = result.manifest as Record<string, unknown>;
    const vars = (manifest.cssVariables ?? manifest.css_variables ?? {}) as Record<string, unknown>;
    const cssVariables: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === "string") cssVariables[k] = v;
    }
    const theme = {
      id: crypto.randomUUID(),
      themeId: result.manifest.id,
      name: result.manifest.name,
      version: result.manifest.version,
      publisher: result.manifest.publisher,
      description: result.manifest.description,
      cssVariables,
      manifest: { ...manifest, installedPath: result.installedPath },
    };
    await insertTheme(siteId, theme);
    res.json({ theme: { ...theme, status: "installed", active: false } });
  } catch (err) {
    sendPackageInstallError(res, err);
  }
});

export default router;
