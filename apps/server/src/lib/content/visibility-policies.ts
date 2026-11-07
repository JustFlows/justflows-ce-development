// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import {
  ContentVisibilityPolicySchema,
  isOpenVisibilityPolicy,
  type ContentVisibilityPolicy,
} from "@justflows/content";
import { getJfCache } from "../cache/jf-cache.js";
import { getDb } from "../database/db.js";
import { getContentTypeSettingsMap } from "./content-types-db.js";

const CACHE_PREFIX = "content:visibility:";
const CACHE_TTL_SECONDS = 60;

/** What an unreadable stored policy becomes: nobody, never everybody. */
const LOCKED_POLICY: ContentVisibilityPolicy = ContentVisibilityPolicySchema.parse({ audience: "nobody" });

export interface VisibilityOverride {
  groupId: string;
  hash: string;
  policy: ContentVisibilityPolicy;
}

export interface VisibilityPolicies {
  /** Type defaults that can keep someone out. Open defaults are left out. */
  types: Map<string, { hash: string; policy: ContentVisibilityPolicy }>;
  /** Per-item overrides by translation group, including ones that open an item up. */
  overrides: Map<string, VisibilityOverride>;
  /** False when nothing on this site can hide anything: every check can be skipped. */
  restricted: boolean;
}

export interface VisibilityItemRef {
  id: string;
  type: string;
  translationGroupId?: string | null;
}

/** Every translation of an entry shares one rule, so no locale can leak what another hides. */
export function visibilityGroupId(item: Pick<VisibilityItemRef, "id" | "translationGroupId">): string {
  return item.translationGroupId ?? item.id;
}

export function visibilityPolicyHash(policy: ContentVisibilityPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function parseStoredPolicy(raw: unknown): ContentVisibilityPolicy {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    const parsed = ContentVisibilityPolicySchema.safeParse(value);
    return parsed.success ? parsed.data : LOCKED_POLICY;
  } catch {
    return LOCKED_POLICY;
  }
}

async function readPolicies(siteId: string) {
  const db = await getDb();
  const [settings, rows] = await Promise.all([
    getContentTypeSettingsMap(siteId),
    db.query<{ group_id: string; policy: unknown; policy_hash: string }>(
      "SELECT group_id, policy, policy_hash FROM content_visibility WHERE site_id = ?",
      [siteId],
    ),
  ]);
  const types: Array<[string, ContentVisibilityPolicy]> = [];
  for (const [slug, value] of settings) {
    if (!isOpenVisibilityPolicy(value.visibility)) types.push([slug, value.visibility!]);
  }
  return {
    types,
    overrides: rows.map((row) => ({
      groupId: String(row.group_id),
      hash: String(row.policy_hash),
      policy: parseStoredPolicy(row.policy),
    })),
  };
}

/** `fresh` skips the cache for callers that must see a change at once. */
export async function loadVisibilityPolicies(
  siteId: string,
  options: { fresh?: boolean } = {},
): Promise<VisibilityPolicies> {
  /** Cached as arrays: a Map does not survive a serializing cache backend. */
  const stored = options.fresh
    ? await readPolicies(siteId)
    : await getJfCache().remember(`${CACHE_PREFIX}${siteId}`, CACHE_TTL_SECONDS, () => readPolicies(siteId));
  const types = new Map(stored.types.map(([slug, policy]) => [slug, { hash: visibilityPolicyHash(policy), policy }]));
  const overrides = new Map(stored.overrides.map((override) => [override.groupId, override]));
  const restricted = types.size > 0 || stored.overrides.some((override) => !isOpenVisibilityPolicy(override.policy));
  return { types, overrides, restricted };
}

/** The policy that applies to an item, and where it came from. An override replaces the type default whole. */
export function effectiveVisibilityPolicy(policies: VisibilityPolicies, item: VisibilityItemRef) {
  const override = policies.overrides.get(visibilityGroupId(item));
  if (override) return { source: "item" as const, hash: override.hash, policy: override.policy };
  const fallback = policies.types.get(item.type);
  if (fallback) return { source: "type" as const, hash: fallback.hash, policy: fallback.policy };
  return { source: "default" as const, hash: null, policy: null };
}

export async function getVisibilityOverride(siteId: string, groupId: string): Promise<ContentVisibilityPolicy | null> {
  const db = await getDb();
  const rows = await db.query<{ policy: unknown }>(
    "SELECT policy FROM content_visibility WHERE site_id = ? AND group_id = ? LIMIT 1",
    [siteId, groupId],
  );
  return rows[0] ? parseStoredPolicy(rows[0].policy) : null;
}

/** Save or, with `null`, clear an override. Callers then run `applyVisibilityChange`. */
export async function saveVisibilityOverride(
  siteId: string,
  groupId: string,
  policy: ContentVisibilityPolicy | null,
  actorId: string | null,
): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM content_visibility WHERE site_id = ? AND group_id = ?", [siteId, groupId]);
    if (!policy) return;
    await tx.run(
      "INSERT INTO content_visibility (site_id, group_id, policy, policy_hash, updated_by) VALUES (?, ?, ?, ?, ?)",
      [siteId, groupId, JSON.stringify(policy), visibilityPolicyHash(policy), actorId],
    );
  });
}

/**
 * Make a rule change take effect everywhere: drop the policy cache and every
 * cached page, list, and menu, purge the CDN, then re-sync the search index. An
 * item change passes its ids. A type default change passes none and rebuilds
 * the index.
 */
export async function applyVisibilityChange(siteId: string, contentIds?: readonly string[]): Promise<void> {
  await getJfCache().invalidate(CACHE_PREFIX);
  const { invalidateContentCache } = await import("./content-public.js");
  await invalidateContentCache(true, siteId);
  /** A page that was public until now may still sit at the edge. */
  const { purgeCdnCache } = await import("../cdn/cdn-purge.js");
  await purgeCdnCache({ siteId }).catch(() => console.error("[justflows] CDN purge after a visibility change failed"));
  const { indexSearchContent, rebuildSearchIndex } = await import("../search/search-db.js");
  if (!contentIds) {
    void rebuildSearchIndex(siteId).catch(() => console.error("[justflows] Search rebuild after a visibility change failed"));
    return;
  }
  /** The reconcile job retries a failed external sync, so a hiccup must not fail the save. */
  for (const id of contentIds) await indexSearchContent(siteId, id).catch(() => undefined);
}
