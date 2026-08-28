// SPDX-License-Identifier: MIT

// Remote core-update discovery.
//
// Every answer here comes from the Justflows API gateway (`/v1/core/*`), which
// is the only thing that talks to GitHub. This module never calls GitHub
// directly, caches the "what is the latest release" answer briefly, and decides
// whether an update is eligible for *automatic* installation.

import { getJustflowsVersion } from "./version.js";

// Hard-coded on purpose. This gateway hands back the download and checksum URLs
// for a core update, so an operator who could repoint it (env var, config) could
// serve an arbitrary archive with a matching digest and replace the running
// core. It is not configurable — matching `routes/marketplace.ts`.
const JUSTFLOWS_API_BASE = "https://api.justflows.com";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface RemoteCoreRelease {
  version: string;
  tag: string;
  name: string;
  publishedAt: string | null;
  prerelease: boolean;
  notesUrl: string;
  downloadUrl: string | null;
  sha256Url: string | null;
  size: number | null;
}

export interface AvailableCoreUpdate {
  id: "justflows";
  name: "Justflows";
  type: "core";
  currentVersion: string;
  availableVersion: string;
  changelog?: string;
  notesUrl: string;
  publishedAt: string | null;
  downloadUrl: string;
  sha256Url: string | null;
  /** True when this jump keeps the same major and can be auto-installed. */
  autoUpdatable: boolean;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseCoreVersion(input: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Negative if `a` < `b`, positive if `a` > `b`, 0 if equal (SemVer precedence). */
export function compareCoreVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) - Number(bi);
    if (an) return -1;
    if (bn) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

/**
 * Automatic updates stay inside the current major line. A major bump can carry
 * breaking changes an operator must opt into by uploading or clicking Update, so
 * the unattended job must never cross `X.*.* → (X+1).*.*`.
 */
export function isAutoUpdateEligible(currentVersion: string, targetVersion: string): boolean {
  const current = parseCoreVersion(currentVersion);
  const target = parseCoreVersion(targetVersion);
  if (!current || !target) return false;
  if (target.prerelease.length > 0) return false;
  if (target.major !== current.major) return false;
  return compareCoreVersions(target, current) > 0;
}

let cache: { at: number; value: RemoteCoreRelease | null } | null = null;
let inflight: Promise<RemoteCoreRelease | null> | null = null;

async function requestLatest(): Promise<RemoteCoreRelease | null> {
  const res = await fetch(`${JUSTFLOWS_API_BASE}/v1/core/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Core release API responded ${res.status}`);
  const body = (await res.json()) as { latest?: RemoteCoreRelease | null };
  return body.latest ?? null;
}

/** Latest stable release known to the gateway. Cached for {@link CACHE_TTL_MS}. */
export async function fetchLatestCoreRelease(force = false): Promise<RemoteCoreRelease | null> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = requestLatest()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .catch((err) => {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS * 3) return cache.value;
      throw err;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The pending update, or `null` when the site is already current. */
export async function getAvailableCoreUpdate(
  options: { force?: boolean } = {},
): Promise<AvailableCoreUpdate | null> {
  const currentVersion = getJustflowsVersion();
  const current = parseCoreVersion(currentVersion);
  const latest = await fetchLatestCoreRelease(options.force);
  if (!latest || !latest.downloadUrl) return null;

  const target = parseCoreVersion(latest.version);
  if (!current || !target) return null;
  if (compareCoreVersions(target, current) <= 0) return null;

  return {
    id: "justflows",
    name: "Justflows",
    type: "core",
    currentVersion,
    availableVersion: latest.version,
    notesUrl: latest.notesUrl,
    publishedAt: latest.publishedAt,
    downloadUrl: latest.downloadUrl,
    sha256Url: latest.sha256Url,
    autoUpdatable: isAutoUpdateEligible(currentVersion, latest.version),
  };
}
