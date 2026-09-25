// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { getDb, type DbClient } from "../database/db.js";
import { getJfCache } from "../cache/jf-cache.js";
import {
  getPermalinkState,
  permalinkContent,
  reservedPermalinkPath,
  listPermalinkTerms,
  taxonomyPermalink,
} from "./permalinks-db.js";
import { localePath, parseLocalePrefix } from "../i18n/locales.js";
import { getHomeContent } from "../content/home-page.js";
import { permalinkPath, slashPath } from "./permalinks.js";
import { getActiveLocaleCodes, getDefaultLocale } from "../i18n/languages-db.js";
import {
  assertNoRedirectLoops,
  matchRedirect,
  redirectRequestPath,
  RedirectValidationError,
  safeRedirectTarget,
  validateRedirect,
  type RedirectInput,
  type RedirectRule,
} from "./redirects.js";

type Reader = Pick<DbClient, "query">;
export async function listRedirects(siteId: string, db?: Reader): Promise<RedirectRule[]> {
  const rows = await (db ?? (await getDb())).query<{ id: string; rule: string }>(
    "SELECT id, rule FROM redirects WHERE site_id = ? ORDER BY id",
    [siteId],
  );
  return rows.map((row) => ({ ...validateRedirect(JSON.parse(row.rule)), id: row.id }));
}

/** Current content identities and historical paths share the existing permalink contract. */
export async function redirectContext(siteId: string) {
  const [items, state, locales, defaultLocale, terms, db] = await Promise.all([
    permalinkContent(siteId),
    getPermalinkState(siteId),
    getActiveLocaleCodes(),
    getDefaultLocale(siteId),
    listPermalinkTerms(siteId),
    getDb(),
  ]);
  const homes = new Set(
    (await Promise.all(locales.map((locale) => getHomeContent(siteId, locale, false))))
      .filter((item) => item !== null)
      .map((item) => item!.id),
  );
  const content = items
    .filter((i) => locales.includes(i.locale))
    .map((i) => ({
      id: i.id,
      title: i.title,
      path: homes.has(i.id)
        ? slashPath(localePath(i.locale, "/", defaultLocale), state.settings.trailingSlash)
        : permalinkPath(i, state.settings, defaultLocale, state.layoutScopes),
    }));
  const sites = await db.query<{ url: string }>("SELECT url FROM sites WHERE id = ?", [siteId]);
  let origin = "";
  try {
    origin = new URL(sites[0]?.url ?? "").origin;
  } catch {
    /* Installation may not have an origin yet. */
  }
  const history: RedirectRule[] = [];
  for (const [source, id] of Object.entries(state.redirects)) {
    const item = content.find((c) => c.id === id);
    if (item && source !== item.path)
      history.push({
        id: `history:${source}`,
        source,
        kind: "exact",
        targetType: "internal",
        target: item.path,
        status: 301,
        enabled: true,
      });
  }
  for (const [source, identity] of Object.entries(state.archiveRedirects ?? {})) {
    const [locale, id] = identity.split(":");
    const term = terms.find((t) => t.id === id);
    if (term && locale && locales.includes(locale)) {
      const target = taxonomyPermalink(term, locale, state.settings, defaultLocale);
      if (source !== target)
        history.push({
          id: `history:${source}`,
          source,
          kind: "exact",
          targetType: "internal",
          target,
          status: 301,
          enabled: true,
        });
    }
  }
  const canonicalPaths = [
    ...content.map((c) => c.path),
    ...terms.flatMap((term) =>
      locales.map((locale) => taxonomyPermalink(term, locale, state.settings, defaultLocale)),
    ),
    ...locales.map((locale) =>
      slashPath(localePath(locale, "/", defaultLocale), state.settings.trailingSlash),
    ),
  ];
  const legacyCandidates = items
    .filter((item) => locales.includes(item.locale))
    .map((item) => ({
      source: localePath(item.locale, `/${item.slug}`, defaultLocale),
      target: content.find((c) => c.id === item.id)!.path,
    }));
  const legacy = legacyCandidates.filter(
    (candidate) =>
      legacyCandidates.filter((other) => other.source === candidate.source).length === 1,
  );
  return {
    content,
    history,
    origin,
    canonicalPaths,
    locales,
    defaultLocale,
    legacy,
    trailingSlash: state.settings.trailingSlash,
  };
}
export function canonicalRedirectTarget(
  target: string,
  context: Awaited<ReturnType<typeof redirectContext>>,
): string {
  if (!safeRedirectTarget(target)) return target;
  const url = new URL(target, "https://redirect.invalid");
  const identity = url.searchParams.get("p");
  const comparable = (value: string) => {
    const [pathname, query] = value.split("?");
    const { locale, restPath } = parseLocalePrefix(pathname!, context.locales);
    return (
      slashPath(
        localePath(locale ?? context.defaultLocale, restPath, context.defaultLocale),
        "never",
      ) + (query ? `?${query}` : "")
    );
  };
  const incoming = url.pathname + (identity ? `?p=${encodeURIComponent(identity)}` : "");
  const lookup = (value: string) =>
    context.canonicalPaths.find((path) => comparable(path) === comparable(value)) ??
    context.history.find((rule) => comparable(rule.source) === comparable(value))?.target ??
    context.legacy.find((alias) => comparable(alias.source) === comparable(value))?.target;
  let canonical = lookup(incoming);
  const pagination = !identity && url.pathname.match(/^(.*)\/page\/([1-9][0-9]*)\/?$/);
  if (!canonical && pagination && Number.isSafeInteger(Number(pagination[2]))) {
    const base = lookup(pagination[1] || "/");
    if (base && !base.includes("?"))
      canonical = slashPath(
        `${base.replace(/\/$/, "")}/page/${pagination[2]}`,
        context.trailingSlash,
      );
  }
  if (!canonical) return target;
  url.searchParams.delete("p");
  const query = url.searchParams.toString();
  return canonical + (query ? `${canonical.includes("?") ? "&" : "?"}${query}` : "") + url.hash;
}
export function materializeRedirects(
  rules: RedirectRule[],
  context: Awaited<ReturnType<typeof redirectContext>>,
): RedirectRule[] {
  const resolved = rules.flatMap((rule) => {
    if (rule.targetType === "content") {
      const item = context.content.find((i) => i.id === rule.target);
      return item ? [{ ...rule, targetType: "internal" as const, target: item.path }] : [];
    }
    if (rule.targetType === "external") {
      const url = new URL(rule.target);
      if (url.origin === context.origin)
        return [
          {
            ...rule,
            targetType: "internal" as const,
            target: url.pathname + url.search + url.hash,
          },
        ];
    }
    return [rule];
  });
  const all = withRedirectHistory(resolved, context.history);
  return resolved.map((rule) => ({
    ...rule,
    target:
      rule.targetType === "internal" &&
      !rule.target.includes("$") &&
      !all.some((next) => matchRedirect(next, redirectRequestPath(rule.target)) !== null)
        ? canonicalRedirectTarget(rule.target, context)
        : rule.target,
  }));
}
export function withRedirectHistory(
  rules: RedirectRule[],
  history: RedirectRule[],
): RedirectRule[] {
  // Enabled exact rules override matching automatic history entries.
  return [
    ...rules,
    ...history.filter(
      (h) => !rules.some((r) => r.enabled && r.kind === "exact" && r.source === h.source),
    ),
  ];
}
export async function runtimeRedirects(siteId: string) {
  const rules = await getJfCache().remember(`redirects:${siteId}`, 5, () => listRedirects(siteId));
  if (!rules.length) return { rules: [], canonicalize: (path: string) => path }; // Existing permalink routing handles history without manual rules.
  const context = await getJfCache().remember(`content:redirect-context:${siteId}`, 5, () =>
    redirectContext(siteId),
  );
  return {
    rules: withRedirectHistory(materializeRedirects(rules, context), context.history),
    canonicalize: (path: string) => canonicalRedirectTarget(path, context),
  };
}

/** Serialize all writers across processes with the site's row lock. Imports are all-or-nothing. */
export async function saveRedirects(
  siteId: string,
  inputs: RedirectInput[],
  editId?: string,
): Promise<RedirectRule[]> {
  const validated = inputs.map(validateRedirect);
  if (!validated.length || validated.length > 500)
    throw new RedirectValidationError("Provide between 1 and 500 redirects.");
  for (const rule of validated) {
    const prefix = rule.kind === "regex" ? rule.source.slice(1, -1).split("(")[0]! : rule.source;
    if (rule.enabled && (await reservedPermalinkPath(prefix)))
      throw new RedirectValidationError("Source conflicts with a platform route.");
  }
  const context = await redirectContext(siteId);
  for (const rule of validated)
    if (
      rule.enabled &&
      rule.targetType === "content" &&
      !context.content.some((c) => c.id === rule.target)
    )
      throw new RedirectValidationError("Content target must be published in an active locale.");
  const db = await getDb();
  const saved = await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM sites WHERE id = ? FOR UPDATE", [siteId]);
    const existing = await listRedirects(siteId, tx);
    if (editId && !existing.some((r) => r.id === editId))
      throw new RedirectValidationError("Redirect not found.");
    const incoming = validated.map((r) => ({ ...r, id: editId ?? randomUUID() }));
    const all = [...existing.filter((r) => r.id !== editId), ...incoming];
    if (all.length > 1000)
      throw new RedirectValidationError("A site can have at most 1000 managed redirects.");
    const keys = all.map((r) => `${r.kind}:${r.source}`);
    if (new Set(keys).size !== keys.length)
      throw new RedirectValidationError(
        "A redirect already exists for this source and match type.",
      );
    assertNoRedirectLoops(withRedirectHistory(materializeRedirects(all, context), context.history));
    for (const rule of incoming) {
      const { id, ...value } = rule;
      if (editId)
        await tx.run("UPDATE redirects SET rule = ? WHERE site_id = ? AND id = ?", [
          JSON.stringify(value),
          siteId,
          id,
        ]);
      else
        await tx.run("INSERT INTO redirects (id, site_id, rule) VALUES (?, ?, ?)", [
          id,
          siteId,
          JSON.stringify(value),
        ]);
    }
    return incoming;
  });
  await Promise.all([
    getJfCache().invalidate(`redirects:${siteId}`),
    getJfCache().invalidate("page:"),
  ]);
  return saved;
}

export interface NotFoundRow {
  path: string;
  hits: number;
  referrer: string;
  firstSeen: string;
  lastSeen: string;
}
export async function listNotFound(siteId: string, offset = 0): Promise<NotFoundRow[]> {
  const rows = await (
    await getDb()
  ).query<{ path: string; hits: number; referrer: string; first_seen: string; last_seen: string }>(
    "SELECT path, hits, referrer, first_seen, last_seen FROM redirect_not_found WHERE site_id = ? AND last_seen >= ? ORDER BY last_seen DESC, path_hash LIMIT 100 OFFSET ?",
    [
      siteId,
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace("T", " "),
      offset,
    ],
  );
  return rows.map((r) => ({
    path: r.path,
    hits: Number(r.hits),
    referrer: r.referrer,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}
export async function clearNotFound(siteId: string): Promise<void> {
  await (await getDb()).run("DELETE FROM redirect_not_found WHERE site_id = ?", [siteId]);
}
/** No IPs, query strings, user agents, or referrer credentials. Last referrer only.
 * Serialized per-site writes make the 10,000-path cap strict on every dialect. */
export async function recordNotFound(
  siteId: string,
  path: string,
  referrer: string,
): Promise<void> {
  if (!safeRedirectTarget(path) || path.includes("?") || path.includes("#")) return;
  let safeReferrer = "";
  try {
    const url = new URL(referrer);
    if (["http:", "https:"].includes(url.protocol))
      safeReferrer = (url.origin + url.pathname).slice(0, 512);
  } catch {
    /* No valid referrer. */
  }
  const hash = createHash("sha256").update(path).digest("hex");
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM sites WHERE id = ? FOR UPDATE", [siteId]);
    await tx.run("DELETE FROM redirect_not_found WHERE site_id = ? AND last_seen < ?", [
      siteId,
      new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace("T", " "),
    ]);
    const updated = await tx.execute(
      "UPDATE redirect_not_found SET hits = hits + 1, last_seen = CURRENT_TIMESTAMP, referrer = ? WHERE site_id = ? AND path_hash = ?",
      [safeReferrer, siteId, hash],
    );
    if (updated) return;
    const count = await tx.query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM redirect_not_found WHERE site_id = ?",
      [siteId],
    );
    if (Number(count[0]?.total) >= 10000) return;
    await tx.run(
      "INSERT INTO redirect_not_found (site_id, path_hash, path, referrer) VALUES (?, ?, ?, ?)",
      [siteId, hash, path, safeReferrer],
    );
  });
}
