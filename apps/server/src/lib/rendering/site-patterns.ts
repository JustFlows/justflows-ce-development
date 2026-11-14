// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { sanitizeBlockDocument } from "@justflows/blocks";
import {
  BlockPatternSchema,
  PatternSetSchema,
  type BlockPattern,
  type PatternSet,
} from "@justflows/sdk";
import { getSiteSetting, updateSiteSettingAtomically } from "../settings/site-settings.js";
import { saveReusableBlock } from "./reusable-blocks.js";

const KEY = "block_patterns";
const MAX_ITEMS = 200;

export interface SitePattern extends BlockPattern {
  source: "site";
  synced: boolean;
  updatedAt: string;
}

function normalize(raw: unknown): SitePattern | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const { source: _source, synced: _synced, updatedAt: _updatedAt, ...pattern } = item;
  const parsed = BlockPatternSchema.safeParse(pattern);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    blocks: sanitizeBlockDocument({ version: 1, blocks: parsed.data.blocks })
      .blocks as BlockPattern["blocks"],
    source: "site",
    synced: item.synced === true,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
  };
}

export function localizeSitePattern(pattern: SitePattern, locale?: string): SitePattern {
  if (!locale || !pattern.locales) return pattern;
  const localized = pattern.locales[locale] ?? pattern.locales[locale.split("-")[0] ?? ""];
  return localized ? { ...pattern, ...localized } : pattern;
}

export async function listSitePatterns(siteId: string, locale?: string): Promise<SitePattern[]> {
  const stored = await getSiteSetting<unknown[]>(siteId, KEY);
  if (!Array.isArray(stored)) return [];
  return stored
    .map(normalize)
    .filter((item): item is SitePattern => item !== null)
    .map((item) => localizeSitePattern(item, locale));
}

export async function saveSitePattern(
  siteId: string,
  input: Record<string, unknown>,
): Promise<SitePattern> {
  const id = typeof input.id === "string" && input.id ? input.id : `pattern-${randomUUID()}`;
  const { synced: _synced, source: _source, updatedAt: _updatedAt, ...pattern } = input;
  const parsed = BlockPatternSchema.parse({ ...pattern, id });
  const entry = normalize({
    ...parsed,
    synced: input.synced === true,
    updatedAt: new Date().toISOString(),
  });
  if (!entry) throw new Error("Invalid pattern");
  /** Atomic so two editors saving different patterns at once never drop each other's (justflows-ce#302). */
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) => {
    const existing = Array.isArray(stored) ? stored.map(normalize).filter((item): item is SitePattern => item !== null) : [];
    const without = existing.filter((item) => item.id !== entry.id);
    if (without.length >= MAX_ITEMS) throw new Error(`A site may hold at most ${MAX_ITEMS} patterns`);
    return [entry, ...without];
  });
  if (entry.synced) {
    await saveReusableBlock(siteId, { id: entry.id, name: entry.title, blocks: entry.blocks });
  }
  return entry;
}

export async function deleteSitePattern(siteId: string, id: string): Promise<void> {
  await updateSiteSettingAtomically<unknown[]>(siteId, KEY, (stored) =>
    (Array.isArray(stored) ? stored : []).filter(
      (item) => !(item && typeof item === "object" && (item as { id?: unknown }).id === id),
    ),
  );
}

export async function importPatternSet(siteId: string, raw: unknown): Promise<SitePattern[]> {
  const set = PatternSetSchema.parse(raw);
  const imported: SitePattern[] = [];
  for (const pattern of set.patterns) imported.push(await saveSitePattern(siteId, pattern));
  return imported;
}

export async function exportPatternSet(siteId: string): Promise<PatternSet> {
  const patterns = await listSitePatterns(siteId);
  return PatternSetSchema.parse({
    schemaVersion: 1,
    patterns: patterns.map(
      ({ source: _source, synced: _synced, updatedAt: _updatedAt, ...pattern }) => pattern,
    ),
  });
}
