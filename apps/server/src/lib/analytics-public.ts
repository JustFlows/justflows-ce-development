// SPDX-License-Identifier: MIT

import type { Request } from "express";
import { getPlugin } from "./plugins-db.js";
import { getPluginSetting } from "./plugin-kv.js";
import { createPluginDataApi } from "./plugin-data.js";
import { getSiteId } from "./themes-db.js";
import { parseGoogleTagId } from "./google-tag.js";

export const ANALYTICS_PLUGIN_ID = "justflows.analytics";

/** Ceiling on distinct referrer hostnames recorded per day (see recordPublicPageview). */
const MAX_REFERRERS_PER_DAY = 200;

function store(siteId: string) {
  return createPluginDataApi(ANALYTICS_PLUGIN_ID, siteId);
}

const SKIP_PREFIXES = [
  "/admin",
  "/api",
  "/login",
  "/register",
  "/install",
  "/uploads",
  "/assets",
  "/css-providers",
  "/theme.css",
];

const SKIP_PATHS = new Set([
  "/sitemap.xml",
  "/robots.txt",
  "/favicon.ico",
  "/justflows-analytics",
  "/justflows-analytics/stats",
]);

export interface AnalyticsCountRow {
  count: number;
  [key: string]: string | number;
}

export interface AnalyticsSummary {
  collecting: boolean;
  enabled: boolean;
  totals: { views: number };
  daily: Array<{ day: string; count: number }>;
  pages: Array<{ path: string; count: number }>;
  referrers: Array<{ referrer: string; count: number }>;
  devices: Array<{ device: string; count: number }>;
}

export async function isAnalyticsPluginEnabled(siteId: string): Promise<boolean> {
  const plugin = await getPlugin(siteId, ANALYTICS_PLUGIN_ID);
  if (plugin?.status !== "active") return false;
  const enabled = await getPluginSetting<boolean>(ANALYTICS_PLUGIN_ID, siteId, "enabled");
  return enabled !== false;
}

function deviceFromUa(ua: string): "mobile" | "tablet" | "desktop" {
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Mobi|Android/i.test(ua)) return "mobile";
  return "desktop";
}

function isBot(ua: string): boolean {
  return /bot|crawl|spider|slurp|bingpreview|facebookexternalhit/i.test(ua);
}

function normalizePath(raw: string): string {
  const path = raw.split("?")[0] ?? "/";
  if (!path.startsWith("/")) return "/";
  return path.slice(0, 200);
}

function shouldSkipPath(path: string): boolean {
  if (SKIP_PATHS.has(path)) return true;
  return SKIP_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function referrerLabel(referer: string | undefined, siteHost: string): string | null {
  if (!referer) return "direct";
  try {
    const url = new URL(referer);
    if (!url.hostname || url.hostname === siteHost) return null;
    return url.hostname.slice(0, 200);
  } catch {
    return null;
  }
}

async function bump(
  siteId: string,
  collection: string,
  id: string,
  fields: Record<string, string>,
): Promise<void> {
  const api = store(siteId);
  const existing = await api.get<AnalyticsCountRow>(collection, id);
  await api.put(collection, id, {
    ...fields,
    count: (existing?.data.count ?? 0) + 1,
  });
}

export async function recordPublicPageview(req: Request): Promise<void> {
  const siteId = await getSiteId();
  if (!siteId || !(await isAnalyticsPluginEnabled(siteId))) return;

  const path = normalizePath(req.path || "/");
  if (shouldSkipPath(path)) return;

  const ua = String(req.headers["user-agent"] ?? "");
  if (isBot(ua)) return;

  const day = new Date().toISOString().slice(0, 10);
  const siteHost = (() => {
    try {
      return new URL(process.env.APP_URL ?? "").hostname;
    } catch {
      return String(req.headers.host ?? "");
    }
  })();

  await bump(siteId, "pageviews", `${day}:${path}`, { day, path });

  const referrer = referrerLabel(
    typeof req.headers.referer === "string" ? req.headers.referer : undefined,
    siteHost,
  );
  if (referrer) {
    // The hostname comes from the visitor's Referer, so the set of distinct
    // values is unbounded and attacker-chosen — one row per referrer per day
    // would let anyone grow the table without limit. Once the day's set is
    // full, everything further is counted as "other".
    const known = await store(siteId).get("referrers", `${day}:${referrer}`);
    if (known) {
      await bump(siteId, "referrers", `${day}:${referrer}`, { day, referrer });
    } else {
      const todays = (await store(siteId).list<AnalyticsCountRow>("referrers")).filter(
        (row) => String(row.data.day ?? "") === day,
      );
      const label = todays.length >= MAX_REFERRERS_PER_DAY ? "other" : referrer;
      await bump(siteId, "referrers", `${day}:${label}`, { day, referrer: label });
    }
  }

  const device = deviceFromUa(ua);
  await bump(siteId, "devices", `${day}:${device}`, { day, device });
}

function mergeCounts<K extends string>(
  rows: Array<{ data: AnalyticsCountRow }>,
  key: K,
): Array<Record<K, string> & { count: number }> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const label = String(row.data[key] ?? "");
    if (!label) continue;
    map.set(label, (map.get(label) ?? 0) + Number(row.data.count ?? 0));
  }
  return [...map.entries()]
    .map(([label, count]) => ({ [key]: label, count }) as Record<K, string> & { count: number })
    .sort((a, b) => b.count - a.count);
}

export async function getAnalyticsSummary(siteId: string): Promise<AnalyticsSummary> {
  const plugin = await getPlugin(siteId, ANALYTICS_PLUGIN_ID);
  const collecting = plugin?.status === "active";
  const enabled = collecting && (await getPluginSetting<boolean>(ANALYTICS_PLUGIN_ID, siteId, "enabled")) !== false;
  const empty: AnalyticsSummary = {
    collecting,
    enabled,
    totals: { views: 0 },
    daily: [],
    pages: [],
    referrers: [],
    devices: [],
  };
  if (!plugin) return empty;

  const api = store(siteId);
  const [pageviews, referrers, devices] = await Promise.all([
    api.list<AnalyticsCountRow>("pageviews"),
    api.list<AnalyticsCountRow>("referrers"),
    api.list<AnalyticsCountRow>("devices"),
  ]);

  const pages = mergeCounts(pageviews, "path").slice(0, 25);
  const referrerRows = mergeCounts(referrers, "referrer").slice(0, 25);
  const deviceRows = mergeCounts(devices, "device");
  const dailyMap = new Map<string, number>();
  for (const row of pageviews) {
    const day = String(row.data.day ?? "");
    if (!day) continue;
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + Number(row.data.count ?? 0));
  }
  const daily = [...dailyMap.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-14);
  const views = pages.reduce((sum, row) => sum + row.count, 0);

  return {
    collecting,
    enabled,
    totals: { views },
    daily,
    pages,
    referrers: referrerRows,
    devices: deviceRows,
  };
}

let googleTagCache: { at: number; value: Promise<string | null> } | null = null;

export function clearGoogleTagIdCache(): void {
  googleTagCache = null;
}

export async function getConfiguredGoogleTagId(): Promise<string | null> {
  const now = Date.now();
  if (googleTagCache && now - googleTagCache.at < 2000) return googleTagCache.value;
  googleTagCache = { at: now, value: loadConfiguredGoogleTagId() };
  return googleTagCache.value;
}

async function loadConfiguredGoogleTagId(): Promise<string | null> {
  const siteId = await getSiteId();
  if (!siteId) return null;
  const plugin = await getPlugin(siteId, ANALYTICS_PLUGIN_ID);
  if (plugin?.status !== "active") return null;
  const raw = await getPluginSetting<string>(ANALYTICS_PLUGIN_ID, siteId, "googleTagId");
  return parseGoogleTagId(String(raw ?? ""));
}

