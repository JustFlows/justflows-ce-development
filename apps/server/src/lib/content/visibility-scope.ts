// SPDX-License-Identifier: MIT
import {
  ANONYMOUS_VIEWER,
  CONTENT_VISIBILITY_REASON_RE,
  decideContentVisibility,
  isOpenVisibilityPolicy,
  type ContentVisibilityDecision,
  type ContentVisibilityPolicy,
  type ContentVisibilityRuleOutcome,
  type ContentVisibilityRuleRef,
  type ContentVisibilityViewer,
} from "@justflows/content";
import type { ContentVisibilitySubject, ContentVisibilitySurface } from "@justflows/sdk";
import type { RegisteredVisibilityRule } from "@justflows/plugin-api";
import { getDb } from "../database/db.js";
import { ensurePluginRuntime, getPluginLoader } from "../plugins/plugin-runtime.js";
import { getTenantContext } from "../tenancy/context.js";
import {
  effectiveVisibilityPolicy,
  loadVisibilityPolicies,
  visibilityGroupId,
  type VisibilityItemRef,
  type VisibilityPolicies,
} from "./visibility-policies.js";
import { currentVisibilityViewer, visibilityRequestMemo } from "./visibility-viewer.js";

const RULE_DEADLINE_MS = 1000;

/**
 * The most items one request evaluates one by one. Only rules with
 * `scope: "item"` reach this. Past it an item stays hidden, never shown.
 */
export const MAX_ITEM_EVALUATIONS = 2000;

/** One viewer's answer for a whole site. Every public read goes through this. */
export interface VisibilityScope {
  /** Whether the site has any rule at all. If so, a result can differ per viewer: do not share it. */
  readonly restricted: boolean;
  allows(item: VisibilityItemRef): boolean;
  /** The same answer as `allows`, as a SQL condition on a `content` table or alias. */
  sql(alias?: string): { sql: string; params: string[] };
}

const OPEN_SCOPE: VisibilityScope = {
  restricted: false,
  allows: () => true,
  sql: () => ({ sql: "1 = 1", params: [] }),
};

function deny(reason: string): ContentVisibilityRuleOutcome {
  return { effect: "deny", reason, failed: true };
}

function pluginIsActive(rule: RegisteredVisibilityRule): boolean {
  const tenant = getTenantContext();
  if (!tenant) return true;
  return tenant.activePluginIds?.has(rule.pluginId) ?? false;
}

function registeredRule(id: string): RegisteredVisibilityRule | null {
  const rule = getPluginLoader()?.visibilityRuleRegistry.get(id);
  return rule && pluginIsActive(rule) ? rule : null;
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Visibility rule timed out")), RULE_DEADLINE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readDecision(value: unknown): ContentVisibilityRuleOutcome {
  const decision = value as { effect?: unknown; reason?: unknown } | null | undefined;
  if (
    (decision?.effect !== "allow" && decision?.effect !== "deny") ||
    typeof decision.reason !== "string" ||
    !CONTENT_VISIBILITY_REASON_RE.test(decision.reason)
  ) {
    return deny("rule_invalid");
  }
  return { effect: decision.effect, reason: decision.reason };
}

/** Runs plugin rules for one viewer, keeping one answer per rule, params, and item. */
function createRuleRunner(siteId: string, viewer: ContentVisibilityViewer, surface: ContentVisibilitySurface) {
  const answers = new Map<string, Promise<ContentVisibilityRuleOutcome>>();
  /** A rule that threw or timed out is not asked again: a listing must not wait on it per item. */
  const broken = new Set<string>();

  async function ask(
    rule: RegisteredVisibilityRule,
    ref: ContentVisibilityRuleRef,
    content: ContentVisibilitySubject | null,
  ): Promise<ContentVisibilityRuleOutcome> {
    if (broken.has(ref.id)) return deny("rule_error");
    try {
      const answer = await withDeadline(
        Promise.resolve().then(() =>
          rule.evaluate({
            siteId,
            content: content ? Object.freeze({ ...content }) : null,
            viewer: Object.freeze({ authenticated: viewer.authenticated, userId: viewer.userId, roles: [...viewer.roles] }),
            params: Object.freeze(structuredClone(ref.params)),
            request: Object.freeze({ surface }),
          }),
        ),
      );
      return readDecision(answer);
    } catch (err) {
      broken.add(ref.id);
      console.error("[justflows] visibility rule failed:", JSON.stringify(ref.id), err instanceof Error ? JSON.stringify(err.message) : "");
      return deny("rule_error");
    }
  }

  return (ref: ContentVisibilityRuleRef, content: ContentVisibilitySubject | null) => {
    const rule = registeredRule(ref.id);
    if (!rule) return Promise.resolve(deny("rule_unavailable"));
    const subject = rule.scope === "viewer" ? null : content;
    /** An `item` rule with no item to look at cannot answer. The caller evaluates it per item instead. */
    if (rule.scope !== "viewer" && !subject) return Promise.resolve(deny("rule_unavailable"));
    const key = JSON.stringify([ref.id, ref.params, subject?.id ?? null]);
    let answer = answers.get(key);
    if (!answer) {
      answer = ask(rule, ref, subject);
      answers.set(key, answer);
    }
    return answer;
  };
}

/** A policy naming a live per-item rule cannot be decided once for all its items. */
function needsItem(policy: ContentVisibilityPolicy): boolean {
  return policy.rules.some((ref) => {
    const rule = registeredRule(ref.id);
    return rule !== null && rule.scope !== "viewer";
  });
}

function subjectFromRow(row: Record<string, unknown>): ContentVisibilitySubject {
  return {
    id: String(row.id),
    type: String(row.type),
    slug: String(row.slug),
    locale: String(row.locale ?? ""),
    translationGroupId: String(row.translation_group_id ?? row.id),
    status: String(row.status),
    authorId: row.author_id == null ? null : String(row.author_id),
  };
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

async function buildScope(
  siteId: string,
  viewer: ContentVisibilityViewer,
  policies: VisibilityPolicies,
): Promise<VisibilityScope> {
  const usesRules = [...policies.types.values(), ...policies.overrides.values()].some(({ policy }) => policy.rules.length > 0);
  if (usesRules) await ensurePluginRuntime();
  const run = createRuleRunner(siteId, viewer, "request");
  const verdicts = new Map<string, "allow" | "deny" | "item">();

  async function judge(hash: string, policy: ContentVisibilityPolicy): Promise<void> {
    if (verdicts.has(hash)) return;
    if (isOpenVisibilityPolicy(policy)) {
      verdicts.set(hash, "allow");
      return;
    }
    if (needsItem(policy)) {
      verdicts.set(hash, "item");
      return;
    }
    const decision = await decideContentVisibility(policy, viewer, (rule) => run(rule, null));
    verdicts.set(hash, decision.allowed ? "allow" : "deny");
  }
  for (const { hash, policy } of policies.types.values()) await judge(hash, policy);
  for (const { hash, policy } of policies.overrides.values()) await judge(hash, policy);

  const typeVerdict = (slug: string) => {
    const entry = policies.types.get(slug);
    return entry ? verdicts.get(entry.hash)! : "allow";
  };
  const hiddenTypes = [...policies.types.keys()].filter((slug) => typeVerdict(slug) !== "allow");
  const overrideHashes = [...new Set([...policies.overrides.values()].map((override) => override.hash))];
  const allowedHashes = overrideHashes.filter((hash) => verdicts.get(hash) === "allow");
  const hiddenHashes = overrideHashes.filter((hash) => verdicts.get(hash) !== "allow");
  const itemHashes = overrideHashes.filter((hash) => verdicts.get(hash) === "item");
  const itemTypes = hiddenTypes.filter((slug) => typeVerdict(slug) === "item");

  const overrideGroups = (hashes: readonly string[]) => ({
    sql: `SELECT group_id FROM content_visibility WHERE content_visibility.site_id = ? AND policy_hash IN (${marks(hashes)})`,
    params: [siteId, ...hashes],
  });

  const allowedIds = new Set<string>();
  if (itemTypes.length || itemHashes.length) {
    const group = "COALESCE(translation_group_id, id)";
    const clauses: string[] = [];
    const params: string[] = [siteId];
    if (itemTypes.length) {
      clauses.push(`(type IN (${marks(itemTypes)}) AND ${group} NOT IN (SELECT group_id FROM content_visibility WHERE content_visibility.site_id = ?))`);
      params.push(...itemTypes, siteId);
    }
    if (itemHashes.length) {
      const inner = overrideGroups(itemHashes);
      clauses.push(`${group} IN (${inner.sql})`);
      params.push(...inner.params);
    }
    const db = await getDb();
    const rows = await db.query<Record<string, unknown>>(
      `SELECT id, type, slug, locale, translation_group_id, status, author_id FROM content
       WHERE site_id = ? AND status = 'published' AND trashed_at IS NULL AND (${clauses.join(" OR ")})
       ORDER BY published_at DESC, id ASC LIMIT ${MAX_ITEM_EVALUATIONS}`,
      params,
    );
    for (const row of rows) {
      const subject = subjectFromRow(row);
      const { policy } = effectiveVisibilityPolicy(policies, {
        id: subject.id,
        type: subject.type,
        translationGroupId: subject.translationGroupId,
      });
      const decision = await decideContentVisibility(policy, viewer, (rule) => run(rule, subject));
      if (decision.allowed) allowedIds.add(subject.id);
    }
  }

  return {
    restricted: true,
    allows(item) {
      const override = policies.overrides.get(visibilityGroupId(item));
      const verdict = override ? verdicts.get(override.hash) : typeVerdict(item.type);
      return verdict === "allow" || (verdict === "item" && allowedIds.has(item.id));
    },
    sql(alias) {
      const prefix = alias ? `${alias}.` : "";
      const group = `COALESCE(${prefix}translation_group_id, ${prefix}id)`;
      if (!hiddenTypes.length && !hiddenHashes.length) return { sql: "1 = 1", params: [] };

      /** Default path: not hidden by type, not hidden by an override. */
      const kept: string[] = [];
      const params: string[] = [];
      if (hiddenTypes.length) {
        kept.push(`${prefix}type NOT IN (${marks(hiddenTypes)})`);
        params.push(...hiddenTypes);
      }
      if (hiddenHashes.length) {
        const inner = overrideGroups(hiddenHashes);
        kept.push(`${group} NOT IN (${inner.sql})`);
        params.push(...inner.params);
      }
      const options = [`(${kept.join(" AND ")})`];
      /** An override that lets this viewer in beats a type default that does not. */
      if (hiddenTypes.length && allowedHashes.length) {
        const inner = overrideGroups(allowedHashes);
        options.push(`${group} IN (${inner.sql})`);
        params.push(...inner.params);
      }
      if (allowedIds.size) {
        options.push(`${prefix}id IN (${marks([...allowedIds])})`);
        params.push(...allowedIds);
      }
      return { sql: `(${options.join(" OR ")})`, params };
    },
  };
}

/** The scope for `viewer`, or for the current request's visitor when left out. */
export async function getVisibilityScope(
  siteId: string,
  viewer?: ContentVisibilityViewer,
): Promise<VisibilityScope> {
  const memo = visibilityRequestMemo();
  const policiesKey = `policies:${siteId}`;
  let loading = memo?.get(policiesKey) as Promise<VisibilityPolicies> | undefined;
  if (!loading) {
    loading = loadVisibilityPolicies(siteId);
    memo?.set(policiesKey, loading);
  }
  const policies = await loading;
  if (!policies.restricted) return OPEN_SCOPE;
  const resolved = viewer ?? (await currentVisibilityViewer());
  const key = `${siteId}:${resolved.userId ?? ""}:${resolved.roles.join(",")}`;
  const existing = memo?.get(key) as Promise<VisibilityScope> | undefined;
  if (existing) return existing;
  const scope = buildScope(siteId, resolved, policies);
  memo?.set(key, scope);
  return scope;
}

/**
 * For output every visitor shares: sitemaps, feeds, exports, plugin reads. A
 * signed-in request gets the same answer as a stranger, so nothing personal
 * lands in something public.
 */
export function getAnonymousVisibilityScope(siteId: string): Promise<VisibilityScope> {
  return getVisibilityScope(siteId, ANONYMOUS_VIEWER);
}

export interface VisibilityExplanation extends ContentVisibilityDecision {
  source: "default" | "type" | "item";
}

/** One decision with the rule that made it, from the current stored policies. */
export async function explainContentVisibility(
  siteId: string,
  row: Record<string, unknown>,
  viewer: ContentVisibilityViewer,
): Promise<VisibilityExplanation> {
  const policies = await loadVisibilityPolicies(siteId, { fresh: true });
  const subject = subjectFromRow(row);
  const { source, policy } = effectiveVisibilityPolicy(policies, {
    id: subject.id,
    type: subject.type,
    translationGroupId: subject.translationGroupId,
  });
  if (policy?.rules.length) await ensurePluginRuntime();
  const run = createRuleRunner(siteId, viewer, "explain");
  const decision = await decideContentVisibility(policy, viewer, (rule) => run(rule, subject));
  return { ...decision, source };
}

/** External search services only ever hold what the whole world may read. */
export async function isOpenToEveryone(siteId: string, item: VisibilityItemRef): Promise<boolean> {
  const policies = await loadVisibilityPolicies(siteId, { fresh: true });
  if (!policies.restricted) return true;
  return isOpenVisibilityPolicy(effectiveVisibilityPolicy(policies, item).policy);
}
