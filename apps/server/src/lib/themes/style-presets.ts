// SPDX-License-Identifier: MIT

import { STYLE_PRESETS_MAX, sanitizeStylePreset, sanitizeStylePresets, type StylePreset } from "@justflows/blocks";
import { findBlockReferences } from "../rendering/block-references.js";
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

/**
 * Where a preset is used, so an editor sees the impact of changing or
 * deleting it. Uses the shared reference scan (`findBlockReferences`), which
 * matches the exact `styleRef` on every database driver.
 */
export async function stylePresetUsage(siteId: string, id: string): Promise<StylePresetUsage> {
  const found = await findBlockReferences(siteId, "styleRef", id);
  const content: Record<string, number> = {};
  for (const row of found.content) content[row.type] = (content[row.type] ?? 0) + 1;
  const usage: StylePresetUsage = {
    content,
    templateParts: found.templateParts,
    templates: found.templates,
    reusableBlocks: found.reusableBlocks.length,
    patterns: found.patterns.length,
    total: 0,
  };
  usage.total =
    found.content.length + usage.templateParts.length + usage.templates.length + found.menus.length + usage.reusableBlocks + usage.patterns;
  return usage;
}
