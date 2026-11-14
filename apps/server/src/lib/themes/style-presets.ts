// SPDX-License-Identifier: MIT

import { STYLE_PRESETS_MAX, sanitizeStylePreset, sanitizeStylePresets, type StylePreset } from "@justflows/blocks";
import { getDb } from "../database/db.js";
import { getSiteSetting, updateSiteSettingAtomically } from "../settings/site-settings.js";

/**
 * Site style presets (justflows-ce#301): storage, draft and publish, and
 * where a preset is used.
 *
 * Like theme mods, presets have a published list and an optional draft list.
 * The builder edits the draft; `/theme.css?preview=1` and the builder canvas
 * show it; Publish copies it over the published list. Both lists are saved
 * with `updateSiteSettingAtomically`, so two editors saving different
 * presets never drop each other's (justflows-ce#302).
 */

export const STYLE_PRESETS_KEY = "block_style_presets";
export const STYLE_PRESETS_DRAFT_KEY = "block_style_presets_draft";

export async function listStylePresets(siteId: string, opts: { draft?: boolean } = {}): Promise<StylePreset[]> {
  if (opts.draft) {
    const draft = await getSiteSetting<unknown>(siteId, STYLE_PRESETS_DRAFT_KEY);
    if (Array.isArray(draft)) return sanitizeStylePresets(draft);
  }
  return sanitizeStylePresets(await getSiteSetting<unknown>(siteId, STYLE_PRESETS_KEY));
}

export async function stylePresetsHaveDraft(siteId: string): Promise<boolean> {
  return Array.isArray(await getSiteSetting<unknown>(siteId, STYLE_PRESETS_DRAFT_KEY));
}

/** The draft list, seeded from the published list the first time it is touched. */
async function mutateDraft(siteId: string, change: (list: StylePreset[]) => StylePreset[]): Promise<StylePreset[]> {
  const published = await listStylePresets(siteId);
  return updateSiteSettingAtomically<unknown[]>(siteId, STYLE_PRESETS_DRAFT_KEY, (stored) => {
    const current = Array.isArray(stored) ? sanitizeStylePresets(stored) : published;
    return change(current);
  }).then(sanitizeStylePresets);
}

/** Add or replace one preset in the draft. */
export async function saveStylePreset(siteId: string, input: unknown): Promise<StylePreset> {
  const preset = sanitizeStylePreset({ ...(input as Record<string, unknown>), updatedAt: new Date().toISOString() });
  if (!preset) throw new Error("Invalid style preset");
  await mutateDraft(siteId, (list) => {
    const without = list.filter((item) => item.id !== preset.id);
    if (without.length >= STYLE_PRESETS_MAX) throw new Error(`A site may hold at most ${STYLE_PRESETS_MAX} style presets`);
    return [...without, preset];
  });
  return preset;
}

export async function deleteStylePreset(siteId: string, id: string): Promise<void> {
  await mutateDraft(siteId, (list) => list.filter((item) => item.id !== id));
}

/** Make the draft the published list and clear the draft. Returns the published list. */
export async function publishStylePresets(siteId: string): Promise<StylePreset[]> {
  const draft = await getSiteSetting<unknown>(siteId, STYLE_PRESETS_DRAFT_KEY);
  if (!Array.isArray(draft)) return listStylePresets(siteId);
  const next = sanitizeStylePresets(draft);
  await updateSiteSettingAtomically<unknown[]>(siteId, STYLE_PRESETS_KEY, () => next);
  await updateSiteSettingAtomically<unknown>(siteId, STYLE_PRESETS_DRAFT_KEY, () => null);
  return next;
}

export async function discardStylePresetDraft(siteId: string): Promise<void> {
  await updateSiteSettingAtomically<unknown>(siteId, STYLE_PRESETS_DRAFT_KEY, () => null);
}

export interface StylePresetUsage {
  /** Content rows that reference the preset, by content type. */
  content: Record<string, number>;
  /** Template parts (`header`, `footer`, `widgets:<area>`) that reference it. */
  templateParts: string[];
  /** Theme template slugs that reference it. */
  templates: string[];
  reusableBlocks: number;
  patterns: number;
  total: number;
}

/** Whether a stored document JSON references the preset. */
function mentions(json: unknown, needle: string): boolean {
  const text = typeof json === "string" ? json : json == null ? "" : JSON.stringify(json);
  return text.includes(needle);
}

/**
 * Where a preset is used, so an editor sees the impact of changing or
 * deleting it. The content scan is one bounded `LIKE` per table on the stored
 * JSON; `styleRef` values are `[a-z0-9-]`, so the needle needs no escaping.
 */
export async function stylePresetUsage(siteId: string, id: string): Promise<StylePresetUsage> {
  const needle = `"styleRef":"${id}"`;
  const like = `%${needle}%`;
  const db = await getDb();
  const content: Record<string, number> = {};
  const rows = await db.query<{ type: string; n: number | string }>(
    "SELECT type, COUNT(*) AS n FROM content WHERE site_id = ? AND trashed_at IS NULL AND blocks LIKE ? GROUP BY type",
    [siteId, like],
  );
  for (const row of rows) content[String(row.type)] = Number(row.n) || 0;
  const parts = await db.query<{ part: string }>(
    "SELECT part FROM template_parts WHERE site_id = ? AND (doc LIKE ? OR draft_doc LIKE ?) ORDER BY part",
    [siteId, like, like],
  );
  const templates = await db.query<{ slug: string }>(
    "SELECT slug FROM theme_templates WHERE site_id = ? AND (doc LIKE ? OR draft_doc LIKE ?) ORDER BY slug",
    [siteId, like, like],
  );
  const reusable = await getSiteSetting<unknown[]>(siteId, "reusable_blocks");
  const patterns = await getSiteSetting<unknown[]>(siteId, "block_patterns");
  const count = (list: unknown) => (Array.isArray(list) ? list.filter((item) => mentions(item, needle)).length : 0);
  const usage: StylePresetUsage = {
    content,
    templateParts: parts.map((row) => String(row.part)),
    templates: templates.map((row) => String(row.slug)),
    reusableBlocks: count(reusable),
    patterns: count(patterns),
    total: 0,
  };
  usage.total =
    Object.values(content).reduce((a, b) => a + b, 0) +
    usage.templateParts.length +
    usage.templates.length +
    usage.reusableBlocks +
    usage.patterns;
  return usage;
}
