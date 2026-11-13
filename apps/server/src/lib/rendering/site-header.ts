// SPDX-License-Identifier: MIT

import {
  clearTemplatePartDraftDoc,
  getTemplatePartDoc,
  getTemplatePartDocs,
  publishTemplatePartDoc,
  saveTemplatePartDraft,
  saveTemplatePartPublished,
  templatePartHasDraft,
} from "./template-parts-db.js";
import {
  DEFAULT_PAGE_HEADER,
  NO_HEADER_REF,
  SITE_DEFAULT_HEADER_REF,
  mergePageHeader,
  parsePageHeader,
  parsePageHeaderPatch,
  type PageHeaderConfig,
} from "./page-header.js";
import { recordDocumentHistory } from "./document-history.js";

export { NO_HEADER_REF, SITE_DEFAULT_HEADER_REF };

/**
 * The site header library: a set of named headers, one flagged as the site
 * default. Unlike the per-page header it replaces, entries are resolved live at
 * render — a page stores only a ref (see `PAGE_HEADER_REF_FIELD`), never a copy.
 *
 * Stored in the `template_parts` table as the "header" part — one published
 * `doc` (this library) and an optional `draft_doc`. It goes through
 * `template-parts-db.ts` directly rather than `template-parts.ts` because that
 * module hardcodes block-document sanitisation, whereas a header library is a
 * richer document of full `PageHeaderConfig` entries.
 */

const PART = "header";

export const MAX_HEADER_ENTRIES = 100;
const MAX_NAME = 120;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface SiteHeaderEntry {
  id: string;
  name: string;
  base: PageHeaderConfig;
  /** Sparse overrides keyed by active locale code; absent key == inherit base. */
  overrides: Record<string, Partial<PageHeaderConfig>>;
  updatedAt: string;
}

export interface SiteHeaderLibrary {
  version: 1;
  /** Entry shown on pages that have not picked one; null == built-in default. */
  defaultId: string | null;
  entries: SiteHeaderEntry[];
}

export interface SiteHeaderOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export function emptyLibrary(): SiteHeaderLibrary {
  return { version: 1, defaultId: null, entries: [] };
}

function asName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  return (name || fallback).slice(0, MAX_NAME);
}

function parseOverrides(raw: unknown): Record<string, Partial<PageHeaderConfig>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Partial<PageHeaderConfig>> = {};
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!locale.trim()) continue;
    const patch = parsePageHeaderPatch(value);
    if (Object.keys(patch).length > 0) out[locale] = patch;
  }
  return out;
}

export function parseSiteHeaderEntry(raw: unknown): SiteHeaderEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" && ID_RE.test(item.id) ? item.id : "";
  if (!id) return null;
  return {
    id,
    name: asName(item.name, id),
    base: parsePageHeader(item.base),
    overrides: parseOverrides(item.overrides),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

export function parseSiteHeaderLibrary(raw: unknown): SiteHeaderLibrary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyLibrary();
  const input = raw as Record<string, unknown>;
  const entries: SiteHeaderEntry[] = [];
  const seen = new Set<string>();
  if (Array.isArray(input.entries)) {
    for (const candidate of input.entries) {
      const entry = parseSiteHeaderEntry(candidate);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
      if (entries.length >= MAX_HEADER_ENTRIES) break;
    }
  }
  const defaultId =
    typeof input.defaultId === "string" && seen.has(input.defaultId) ? input.defaultId : null;
  return { version: 1, defaultId, entries };
}

/**
 * Pick the entry a page should render.
 *  - {@link NO_HEADER_REF}           -> hidden, no entry
 *  - falsy / {@link SITE_DEFAULT_HEADER_REF} -> the library default (or none)
 *  - a concrete id                  -> that entry, else the library default
 */
export function resolveHeaderEntry(
  lib: SiteHeaderLibrary,
  ref: string | null | undefined,
): { entry: SiteHeaderEntry | null; hidden: boolean } {
  if (ref === NO_HEADER_REF) return { entry: null, hidden: true };
  const byDefault = lib.defaultId
    ? lib.entries.find((e) => e.id === lib.defaultId) ?? null
    : null;
  if (!ref || ref === SITE_DEFAULT_HEADER_REF) return { entry: byDefault, hidden: false };
  const chosen = lib.entries.find((e) => e.id === ref);
  return { entry: chosen ?? byDefault, hidden: false };
}

/** The concrete header config for an entry in a given locale (exact locale -> base). */
export function headerConfigForLocale(
  entry: SiteHeaderEntry | null,
  locale: string,
): PageHeaderConfig {
  if (!entry) return { ...DEFAULT_PAGE_HEADER, blocks: [] };
  return mergePageHeader(entry.base, entry.overrides[locale]);
}

export async function getSiteHeaderLibrary(siteId: string, draft = false): Promise<SiteHeaderLibrary> {
  const stored = await getTemplatePartDoc<unknown>(siteId, PART, { draft });
  return stored == null ? emptyLibrary() : parseSiteHeaderLibrary(stored);
}

/** Has an unpublished working copy been saved? */
export async function hasSiteHeaderLibraryDraft(siteId: string): Promise<boolean> {
  return templatePartHasDraft(siteId, PART);
}

/**
 * The library the public site should use. The draft wins in preview whenever a
 * draft row exists at all — an "empty" library (no entries) is a legitimate
 * saved state, so we cannot gate on `entries.length` the way the footer does.
 */
export async function getEffectiveSiteHeaderLibrary(
  siteId: string,
  preview: boolean,
): Promise<SiteHeaderLibrary> {
  const { doc, draft } = await getTemplatePartDocs<unknown>(siteId, PART);
  if (preview && draft != null) return parseSiteHeaderLibrary(draft);
  return doc == null ? emptyLibrary() : parseSiteHeaderLibrary(doc);
}

export async function saveSiteHeaderLibrary(
  siteId: string,
  lib: unknown,
  draft = false,
): Promise<SiteHeaderLibrary> {
  const parsed = parseSiteHeaderLibrary(lib);
  const revision = draft
    ? await saveTemplatePartDraft(siteId, PART, parsed)
    : await saveTemplatePartPublished(siteId, PART, parsed);
  await recordDocumentHistory({ siteId, kind: "template_part", key: PART, revision, state: draft ? "draft" : "published", doc: parsed });
  return parsed;
}

export async function clearSiteHeaderLibraryDraft(siteId: string): Promise<void> {
  await clearTemplatePartDraftDoc(siteId, PART);
}

/**
 * Publish the library: write the published copy and drop any leftover draft, so
 * a stale draft cannot keep outranking it in preview.
 */
export async function publishSiteHeaderLibrary(
  siteId: string,
  lib: unknown,
): Promise<SiteHeaderLibrary> {
  const parsed = parseSiteHeaderLibrary(lib);
  const revision = await publishTemplatePartDoc(siteId, PART, parsed);
  await recordDocumentHistory({ siteId, kind: "template_part", key: PART, revision, state: "published", doc: parsed });
  return parsed;
}

/**
 * Save the library as a draft or publish it, with an optional revision check.
 * Returns the stored library and the row's new revision; a stale
 * `expectedRevision` throws `DocumentRevisionConflictError`.
 */
export async function writeSiteHeaderLibrary(
  siteId: string,
  lib: unknown,
  opts: { draft: boolean; expectedRevision?: number; actorId?: string | null },
): Promise<{ library: SiteHeaderLibrary; revision: number }> {
  const parsed = parseSiteHeaderLibrary(lib);
  const revision = opts.draft
    ? await saveTemplatePartDraft(siteId, PART, parsed, opts.expectedRevision)
    : await publishTemplatePartDoc(siteId, PART, parsed, opts.expectedRevision);
  await recordDocumentHistory({
    siteId,
    kind: "template_part",
    key: PART,
    revision,
    state: opts.draft ? "draft" : "published",
    doc: parsed,
    actorId: opts.actorId,
  });
  return { library: parsed, revision };
}

/** The header library row's current revision, or 0 when it has never been saved. */
export async function getSiteHeaderLibraryRevision(siteId: string): Promise<number> {
  return (await getTemplatePartDocs(siteId, PART)).revision;
}

/** Lightweight list for the per-page header dropdown. */
export async function listSiteHeaderOptions(
  siteId: string,
  preview = false,
): Promise<{ defaultId: string | null; items: SiteHeaderOption[] }> {
  const lib = await getEffectiveSiteHeaderLibrary(siteId, preview);
  return {
    defaultId: lib.defaultId,
    items: lib.entries.map((e) => ({ id: e.id, name: e.name, isDefault: e.id === lib.defaultId })),
  };
}
