// SPDX-License-Identifier: MIT

/**
 * Admin-configurable sources for the public error pages (justflows-ce#92):
 * for 404/403/410/429, which of the theme's own resolution, a built-in page,
 * or a specific published CMS page renders when that class of error fires.
 *
 * 500 and maintenance are deliberately not configurable through this module —
 * they must render without a database, so they only ever get a static,
 * dependency-free page with admin-editable plain-text heading/message
 * (see `static-error-page.ts`). Their config still lives in the same
 * `error_pages` site setting for a single admin surface, but is read directly
 * by the callers that need it (the Express 500 backstop, the maintenance
 * gate) rather than through {@link getErrorPageConfig}'s page-source logic.
 */

import { z } from "zod";
import { sanitizePlainText } from "@justflows/blocks";
import { getDb } from "../database/db.js";
import { serializeContentRow, type ContentResponse } from "../content/content-api.js";
import { getSiteSetting, setSiteSetting } from "../settings/site-settings.js";
import { revalidateOnUpdate } from "../cache/cache-revalidate.js";
import { getDefaultLocale } from "../i18n/languages-db.js";

export const ERROR_PAGE_SETTING_KEY = "error_pages";

export const PICKER_ERROR_CLASSES = ["404", "403", "410", "429"] as const;
export type PickerErrorClass = (typeof PICKER_ERROR_CLASSES)[number];

const ErrorPageSourceConfigSchema = z
  .object({
    source: z.enum(["theme", "builtin", "page"]),
    pageId: z.string().uuid().optional(),
  })
  .refine((v) => v.source !== "page" || !!v.pageId, {
    message: "pageId is required when source is \"page\"",
  });

export type ErrorPageSourceConfig = z.infer<typeof ErrorPageSourceConfigSchema>;

const StaticErrorCopySchema = z.object({
  heading: z.string().max(200).optional(),
  message: z.string().max(2000).optional(),
});

export type StaticErrorCopy = z.infer<typeof StaticErrorCopySchema>;

const MaintenanceConfigSchema = StaticErrorCopySchema.extend({
  enabled: z.boolean().default(false),
});

export type MaintenanceConfig = z.infer<typeof MaintenanceConfigSchema>;

export const ErrorPageConfigSchema = z
  .object({
    "404": ErrorPageSourceConfigSchema,
    "403": ErrorPageSourceConfigSchema,
    "410": ErrorPageSourceConfigSchema,
    "429": ErrorPageSourceConfigSchema,
    "500": StaticErrorCopySchema,
    maintenance: MaintenanceConfigSchema,
  })
  .partial();

export type ErrorPageConfig = z.infer<typeof ErrorPageConfigSchema>;

const DEFAULT_PICKER_ENTRY: ErrorPageSourceConfig = { source: "theme" };

/** An unset key, or a key that fails to parse, behaves exactly like today (theme resolution, no maintenance). */
export async function getErrorPageConfig(siteId: string): Promise<ErrorPageConfig> {
  const stored = await getSiteSetting<unknown>(siteId, ERROR_PAGE_SETTING_KEY);
  const parsed = ErrorPageConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

export async function getErrorPageSource(
  siteId: string,
  errorClass: PickerErrorClass,
): Promise<ErrorPageSourceConfig> {
  const config = await getErrorPageConfig(siteId);
  return config[errorClass] ?? DEFAULT_PICKER_ENTRY;
}

function sanitizeCopy(copy: StaticErrorCopy | undefined): StaticErrorCopy | undefined {
  if (!copy) return copy;
  const heading = copy.heading != null ? sanitizePlainText(copy.heading).trim() : undefined;
  const message = copy.message != null ? sanitizePlainText(copy.message).trim() : undefined;
  return { heading, message };
}

async function validatePageSource(siteId: string, pageId: string): Promise<void> {
  const db = await getDb();
  const rows = await db.query<{ id: string; type: string; status: string }>(
    "SELECT id, type, status FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [pageId, siteId],
  );
  const row = rows[0];
  if (!row) throw new Error("Page not found");
  if (row.type !== "page") throw new Error("Error page source must be a page");
  if (row.status !== "published") throw new Error("Error page source must be published");
}

/**
 * Merge `patch` over the site's current error-page config and persist it.
 * Validates every `source: "page"` entry against the content table (must be a
 * published page) and sanitizes the 500/maintenance plain-text copy.
 */
export async function setErrorPageConfig(
  siteId: string,
  patch: ErrorPageConfig,
): Promise<ErrorPageConfig> {
  const parsedPatch = ErrorPageConfigSchema.parse(patch);

  for (const errorClass of PICKER_ERROR_CLASSES) {
    const entry = parsedPatch[errorClass];
    if (entry?.source === "page" && entry.pageId) {
      await validatePageSource(siteId, entry.pageId);
    }
  }

  const current = await getErrorPageConfig(siteId);
  const merged: ErrorPageConfig = { ...current, ...parsedPatch };
  if (parsedPatch["500"]) merged["500"] = sanitizeCopy(parsedPatch["500"]);
  if (parsedPatch.maintenance) {
    merged.maintenance = {
      ...parsedPatch.maintenance,
      ...sanitizeCopy(parsedPatch.maintenance),
    };
  }

  await setSiteSetting(siteId, ERROR_PAGE_SETTING_KEY, merged);
  await revalidateOnUpdate("settings");
  return merged;
}

/** Reset any error-page entry pointing at this page back to the theme default — called on hard delete. */
export async function clearErrorPageIfMatches(siteId: string, contentId: string): Promise<void> {
  await clearErrorPagesIfMatch(siteId, new Set([contentId]));
}

export async function clearErrorPagesIfMatch(siteId: string, contentIds: ReadonlySet<string>): Promise<void> {
  if (!contentIds.size) return;
  const current = await getErrorPageConfig(siteId);
  let changed = false;
  const next: ErrorPageConfig = { ...current };
  for (const errorClass of PICKER_ERROR_CLASSES) {
    const entry = next[errorClass];
    if (entry?.source === "page" && entry.pageId && contentIds.has(entry.pageId)) {
      next[errorClass] = DEFAULT_PICKER_ENTRY;
      changed = true;
    }
  }
  if (changed) {
    await setSiteSetting(siteId, ERROR_PAGE_SETTING_KEY, next);
    await revalidateOnUpdate("settings");
  }
}

function isUsable(row: Record<string, unknown>): boolean {
  return String(row.status ?? "") === "published";
}

/**
 * Resolve the published page an admin picked as an error-page source, in this
 * locale — same translation-group preference as `getHomeContent`. Returns
 * `null` when the page was deleted or unpublished since it was selected, so
 * the caller can fall back to the theme/built-in page instead of failing.
 */
export async function resolveErrorPageContent(
  siteId: string,
  locale: string,
  pageId: string,
): Promise<ContentResponse | null> {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT * FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
    [pageId, siteId],
  );
  const row = rows[0];
  if (!row) return null;

  const groupId = row.translation_group_id == null ? null : String(row.translation_group_id);
  if (groupId) {
    const localized = await db.query<Record<string, unknown>>(
      "SELECT * FROM content WHERE site_id = ? AND translation_group_id = ? AND locale = ? AND status = 'published' AND trashed_at IS NULL LIMIT 1",
      [siteId, groupId, locale],
    );
    if (localized[0]) return serializeContentRow(localized[0]);
  }

  if (isUsable(row)) return serializeContentRow(row);
  return null;
}

export interface ErrorPagePickerOption {
  id: string;
  title: string;
  slug: string;
}

/**
 * Published pages an admin can pick as an error-page source, one entry per
 * translation group — the same group a picked page resolves through at
 * render time (see {@link resolveErrorPageContent}), so a single choice here
 * already covers every locale that page has a published translation in.
 * Never lists a page's individual locale variants as separate options.
 */
export async function listErrorPagePickerOptions(siteId: string): Promise<ErrorPagePickerOption[]> {
  const db = await getDb();
  const defaultLocale = await getDefaultLocale(siteId);
  const rows = await db.query<{
    id: string;
    title: string;
    slug: string;
    locale: string;
    translation_group_id: string | null;
  }>(
    "SELECT id, title, slug, locale, translation_group_id FROM content WHERE site_id = ? AND type = 'page' AND status = 'published' AND trashed_at IS NULL ORDER BY title ASC",
    [siteId],
  );

  const byGroup = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.translation_group_id ?? row.id;
    const group = byGroup.get(key);
    if (group) group.push(row);
    else byGroup.set(key, [row]);
  }

  const options = [...byGroup.values()].map((group) => {
    const rep = group.find((row) => row.locale === defaultLocale) ?? group[0]!;
    return { id: rep.id, title: rep.title, slug: rep.slug };
  });
  options.sort((a, b) => a.title.localeCompare(b.title));
  return options;
}
