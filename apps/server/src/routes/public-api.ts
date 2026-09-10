import { rateLimit } from "express-rate-limit";
import { SearchQuerySchema } from "@justflows/content";
import { searchContent } from "../lib/search-db.js";
import { contentPermalink } from "../lib/permalinks-db.js";
import { Router } from "express";
import { getDb } from "../lib/db.js";
import { runHealthChecks } from "../lib/health-checks.js";
import { serializeContentRow } from "../lib/content-api.js";
import { overlayWorkingOnRow } from "../lib/content-revisions.js";
import { resolveContentLocale, getDefaultLocale, getActiveLocaleCodes } from "../lib/i18n/languages-db.js";
import { listContentTypes } from "../lib/content-types-db.js";
import { PUBLIC_API_OPENAPI } from "../lib/openapi-v1.js";
import {
  getEffectiveMenuDesign,
  getEffectiveMenuItems,
  listMenus,
  getMenuBySlug,
  resolveMenuItems,
} from "../lib/menus-db.js";
import { getRuntimeHooks } from "../lib/plugin-runtime.js";
import { requireRole } from "../middleware/auth.js";
import { getSiteId } from "../lib/site-settings.js";
import { canViewUnpublishedSite, isSitePublic } from "../lib/site-visibility.js";
import type { Request, Response } from "express";
import { sendServerError } from "../lib/send-error.js";

const router = Router();

async function ensurePublicApiAccess(req: Request, res: Response): Promise<boolean> {
  if (await isSitePublic()) return true;
  if (await canViewUnpublishedSite(req, res)) return true;
  res.status(404).json({ error: "Not found" });
  return false;
}

function wantsPreview(req: Request): boolean {
  const value = req.query.preview;
  return value === "1" || value === "true";
}

async function allowPreview(req: Request, res: Response): Promise<boolean> {
  return wantsPreview(req) && (await canViewUnpublishedSite(req, res));
}

async function serializePublicContent(
  row: Record<string, unknown>,
  siteId: string,
  preview = false,
): Promise<ReturnType<typeof serializeContentRow>> {
  const overlaid = preview ? await overlayWorkingOnRow(row, true) : row;
  const content = serializeContentRow(overlaid);
  const payload = { ...content, links: { self: await contentPermalink(content) } };
  const hooks = getRuntimeHooks();
  if (!hooks.has("content.output")) return payload;
  return hooks.applyFilter("content.output", payload, { siteId });
}

function serializeMediaRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    filename: String(row.filename),
    mimeType: String(row.mime_type ?? row.mimeType ?? ""),
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes ?? 0),
    url: String(row.url),
    altText: row.alt_text == null ? null : String(row.alt_text),
    caption: row.caption == null ? null : String(row.caption),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    uploadedAt: String(row.uploaded_at ?? row.uploadedAt ?? ""),
  };
}

router.get("/openapi.json", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  const hooks = getRuntimeHooks();
  const document = structuredClone(PUBLIC_API_OPENAPI) as import("@justflows/sdk").OpenApiDocument;
  if (!hooks.has("openapi.document")) {
    res.json(document);
    return;
  }
  res.json(await hooks.applyFilter("openapi.document", document, { version: "v1" }));
});

router.get("/search", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (!(await ensurePublicApiAccess(req, res))) return;
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid search parameters" }); return; }
  try {
    const siteId = await getSiteId();
    if (!siteId) { res.status(404).json({ error: "Not found" }); return; }
    if (parsed.data.locale && !(await getActiveLocaleCodes(siteId)).some(locale => locale.toLowerCase() === parsed.data.locale!.toLowerCase())) {
      res.status(400).json({ error: "Unknown search locale" }); return;
    }
    const locale = await resolveContentLocale(parsed.data.locale ?? await getDefaultLocale(siteId), siteId);
    res.json(await searchContent(siteId, { ...parsed.data, locale }));
  } catch (err) { sendServerError(res, "search", err); }
});

router.get("/content-types", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  try {
    const types = await listContentTypes();
    res.json({
      types: types.map((type) => ({
        slug: type.slug,
        label: type.label,
        description: type.description,
        builtin: type.builtin,
        fields: type.fields,
      })),
    });
  } catch (err) {
    sendServerError(res, "public-api", err);
  }
});

router.get("/media", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  const limit = Math.min(Number(req.query.limit ?? "40"), 200);

  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.json({ items: [] });
      return;
    }
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      "SELECT id, filename, mime_type, size_bytes, url, alt_text, caption, width, height, uploaded_at FROM media WHERE site_id = ? AND trashed_at IS NULL ORDER BY uploaded_at DESC LIMIT ?",
      [siteId, limit],
    );
    res.json({ items: rows.map(serializeMediaRow) });
  } catch (err) {
    sendServerError(res, "public-api", err);
  }
});

router.get("/menus", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.json({ menus: [] });
      return;
    }
    const locale = await resolveContentLocale(req.query.locale as string | undefined, siteId);
    const defaultLocale = await getDefaultLocale(siteId);
    const preview = await allowPreview(req, res);
    const menus = await listMenus(siteId);
    const items = await Promise.all(
      menus.map(async (menu) => ({
        slug: menu.slug,
        name: menu.name,
        design: getEffectiveMenuDesign(menu, preview),
        // The public API has no visitor session of its own — every request resolves as a
        // guest, so an item gated on auth state/role/plugin condition is never returned here.
        items: await resolveMenuItems(getEffectiveMenuItems(menu, preview), locale, defaultLocale, preview, {
          siteId,
          visibility: { authState: "guest" },
        }),
      })),
    );
    res.json({ menus: items, locale });
  } catch (err) {
    sendServerError(res, "public-api", err);
  }
});

router.get("/menus/:slug", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const menu = await getMenuBySlug(siteId, String(req.params.slug));
    if (!menu) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const locale = await resolveContentLocale(req.query.locale as string | undefined, siteId);
    const defaultLocale = await getDefaultLocale(siteId);
    const preview = await allowPreview(req, res);
    res.json({
      menu: {
        slug: menu.slug,
        name: menu.name,
        design: getEffectiveMenuDesign(menu, preview),
        items: await resolveMenuItems(getEffectiveMenuItems(menu, preview), locale, defaultLocale, preview, {
          siteId,
          visibility: { authState: "guest" },
        }),
      },
      locale,
    });
  } catch (err) {
    sendServerError(res, "public-api", err);
  }
});

router.get("/content", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  const type = req.query.type as string | undefined;
  const slug = req.query.slug as string | undefined;
  const localeParam = req.query.locale as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? "20"), 100);
  const cursor = req.query.cursor as string | undefined;
  const preview = await allowPreview(req, res);

  try {
    const db = await getDb();
    const siteId = await getSiteId();
    if (!siteId) {
      res.json({ items: [], total: 0 });
      return;
    }

    const locale = await resolveContentLocale(localeParam, siteId);

    let sql =
      "SELECT id, site_id, type, title, slug, locale, excerpt, status, fields, author_id, created_at, published_at, updated_at FROM content WHERE site_id = ? AND locale = ? AND trashed_at IS NULL";
    const params: (string | number | boolean | null)[] = [siteId, locale];

    if (!preview) {
      sql += " AND status = 'published'";
    }
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    if (slug) {
      sql += " AND slug = ?";
      params.push(slug);
    }
    if (cursor) {
      sql += " AND id > ?";
      params.push(cursor);
    }

    sql += preview ? " ORDER BY updated_at DESC LIMIT ?" : " ORDER BY published_at DESC LIMIT ?";
    params.push(limit + 1);

    const rows = await db.query<Record<string, unknown>>(sql, params);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      items: await Promise.all(items.map((row) => serializePublicContent(row, siteId, preview))),
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
      total: items.length,
      locale,
    });
  } catch (err) {
    sendServerError(res, "public-api", err);
  }
});

router.get("/content/:slug", async (req, res) => {
  if (!(await ensurePublicApiAccess(req, res))) return;
  const preview = await allowPreview(req, res);

  try {
    const db = await getDb();
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const locale = await resolveContentLocale(req.query.locale as string | undefined, siteId);
    const sql = preview
      ? "SELECT * FROM content WHERE site_id = ? AND slug = ? AND locale = ? AND trashed_at IS NULL LIMIT 1"
      : "SELECT * FROM content WHERE site_id = ? AND slug = ? AND locale = ? AND status = 'published' AND trashed_at IS NULL LIMIT 1";

    const rows = await db.query<Record<string, unknown>>(sql, [siteId, req.params.slug, locale]);
    if (!rows[0]) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json(await serializePublicContent(rows[0], siteId, preview));
  } catch (err) {
    sendServerError(res, "public-api", err);
  }
});

const healthRouter = Router();

// Health output carries database connection errors (which name the host and
// driver), memory figures, and which environment variables are unset.
healthRouter.get("/", requireRole("administrator"), async (_req, res) => {
  res.json(await runHealthChecks());
});

export { healthRouter };
export default router;
