// SPDX-License-Identifier: MIT

import { randomBytes, randomUUID } from "node:crypto";
import { getControlDb } from "../database/db.js";
import { borrowSeparateDatabase, separateDatabaseForSite } from "../tenancy/connections.js";
import type { DatabaseChoice, DatabaseMode } from "../tenancy/context.js";
import {
  isLoopbackHost,
  isValidHostname,
  normalizeHostname,
  siteDomainKind,
} from "../tenancy/host.js";
import { checkQuota, enforceQuota, type QuotaBlock } from "../tenancy/quotas.js";
import { platformBaseDomain } from "../tenancy/saas-settings.js";
import {
  challengeName,
  challengeValue,
  checkNameserverDomain,
  checkNameservers,
  checkRecords,
  systemResolver,
  type DnsResolver,
} from "./dns-check.js";
import {
  readDomainSettings,
  type ConnectMode,
  type StoredDomainSettings,
} from "./domain-settings.js";
import { BUNNY_NAMESERVERS } from "./providers/bunny.js";
import { DNS_RECORD_TYPES, type DnsRecordInput, type DnsRecordType } from "./providers/types.js";
import {
  DomainProviderError,
  domainProviderFor,
  type DnsRecord,
  type DomainProvider,
} from "./providers/index.js";

export type DomainStatus = "pending" | "active" | "failed";
export type TlsStatus = "none" | "pending" | "issued" | "external";

interface DomainRow {
  id: string;
  site_id: string;
  hostname: string;
  kind: string;
  verified: unknown;
  is_primary: unknown;
  status: string;
  connect_mode: string | null;
  verification_token: string | null;
  parent_id: string | null;
  provider: string | null;
  dns_zone_id: string | null;
  tls_status: string | null;
  last_error: string | null;
  check_failures: number | string;
  checked_at: string | Date | null;
  verified_at: string | Date | null;
  ownership_proven_at?: string | Date | null;
  provider_attached_at?: string | Date | null;
  created_at: string | Date;
}

const COLUMNS = `id, site_id, hostname, kind, verified, is_primary, status, connect_mode, verification_token, parent_id,
  provider, dns_zone_id, tls_status, last_error, check_failures, checked_at, verified_at, ownership_proven_at, provider_attached_at, created_at`;

export interface DnsInstruction {
  type: "TXT" | "CNAME" | "A" | "AAAA" | "NS" | "ALIAS";
  name: string;
  value: string;
  /** Why the record is needed. */
  purpose: "verify" | "route" | "nameserver";
}

export interface SiteDomainView {
  id: string;
  hostname: string;
  kind: "primary" | "subdomain" | "custom";
  status: DomainStatus;
  isPrimary: boolean;
  verified: boolean;
  mode: ConnectMode | null;
  /** Set on a `www.` row that follows its parent domain. */
  parentId: string | null;
  tlsStatus: TlsStatus;
  lastError: string | null;
  checkedAt: string | null;
  managedZone: boolean;
  instructions: DnsInstruction[];
}

export interface DomainAccess {
  /** The platform offers custom domains at all. */
  available: boolean;
  /** This website may add one. False with `reason` when a plan does not include it. */
  allowed: boolean;
  reason: string | null;
  modes: ConnectMode[];
  limit: number | null;
  used: number;
  upgradeUrl: string | null;
  provider: "manual" | "bunny";
  includeWww: boolean;
}

export type DomainResult<T> =
  { ok: true; value: T } | { ok: false; status: number; error: string; code?: string };

function fail<T>(status: number, error: string, code?: string): DomainResult<T> {
  return { ok: false, status, error, code };
}

function fromBlock<T>(block: QuotaBlock): DomainResult<T> {
  return { ok: false, status: block.status, error: block.error, code: block.code };
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function asTime(value: string | Date | null): string | null {
  if (!value) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(
          String(value).replace(" ", "T") +
            (String(value).includes("Z") || String(value).includes("+") ? "" : "Z"),
        );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageMs(value: string | Date | null): number {
  const iso = asTime(value);
  return iso ? Date.now() - new Date(iso).getTime() : Number.POSITIVE_INFINITY;
}

function asStatus(value: string): DomainStatus {
  return value === "pending" || value === "failed" ? value : "active";
}

function asTls(value: string | null): TlsStatus {
  return value === "pending" || value === "issued" || value === "external" ? value : "none";
}

function asMode(value: string | null): ConnectMode | null {
  return value === "records" || value === "nameservers" ? value : null;
}

function asKind(value: string): SiteDomainView["kind"] {
  return value === "primary" || value === "subdomain" ? value : "custom";
}

function shortError(err: unknown): string {
  const message =
    err instanceof DomainProviderError ? err.message : "The domain provider could not be reached.";
  return message.replace(/[\r\n]/g, " ").slice(0, 500);
}

function expectedNameservers(settings: StoredDomainSettings): string[] {
  return settings.nameservers.length >= 2
    ? settings.nameservers.slice(0, 2)
    : settings.provider === "bunny"
      ? [...BUNNY_NAMESERVERS]
      : [];
}

export function dnsInstructions(
  row: Pick<DomainRow, "hostname" | "connect_mode" | "verification_token" | "parent_id"> &
    Partial<Pick<DomainRow, "ownership_proven_at">>,
  settings: StoredDomainSettings,
): DnsInstruction[] {
  const mode = asMode(row.connect_mode);
  if (row.parent_id || !mode) return [];
  if (mode === "nameservers") {
    // The customer publishes the TXT record at the authoritative DNS provider.
    // Verification accepts the exact token before or after delegation.
    const verify: DnsInstruction[] =
      row.verification_token && !row.ownership_proven_at
        ? [{ type: "TXT", name: challengeName(row.hostname), value: challengeValue(row.verification_token), purpose: "verify" }]
        : [];
    return [
      ...verify,
      ...expectedNameservers(settings).map((ns): DnsInstruction => ({
        type: "NS",
        name: row.hostname,
        value: ns,
        purpose: "nameserver",
      })),
    ];
  }
  const list: DnsInstruction[] = [];
  if (row.verification_token) {
    list.push({
      type: "TXT",
      name: challengeName(row.hostname),
      value: challengeValue(row.verification_token),
      purpose: "verify",
    });
  }
  const apex = row.hostname.split(".").length === 2;
  if (settings.cnameTarget) {
    list.push({
      type: apex ? "ALIAS" : "CNAME",
      name: row.hostname,
      value: settings.cnameTarget,
      purpose: "route",
    });
  }
  if (apex) {
    for (const ip of settings.apexAddresses) {
      list.push({
        type: ip.includes(":") ? "AAAA" : "A",
        name: row.hostname,
        value: ip,
        purpose: "route",
      });
    }
  }
  return list;
}

function view(row: DomainRow, settings: StoredDomainSettings): SiteDomainView {
  const status = asStatus(row.status);
  return {
    id: String(row.id),
    hostname: String(row.hostname),
    kind: asKind(String(row.kind)),
    status,
    isPrimary: asBool(row.is_primary),
    verified: asBool(row.verified),
    mode: asMode(row.connect_mode),
    parentId: row.parent_id ? String(row.parent_id) : null,
    tlsStatus: asTls(row.tls_status),
    lastError: row.last_error ? String(row.last_error) : null,
    checkedAt: asTime(row.checked_at),
    managedZone: Boolean(row.dns_zone_id),
    instructions: status === "active" ? [] : dnsInstructions(row, settings),
  };
}

async function action(name: string, payload: object, siteId: string): Promise<void> {
  try {
    const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
    await getRuntimeHooks().dispatchAction(name, payload, { siteId, source: "system" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    console.error(
      "[justflows] domain hook failed:",
      JSON.stringify(name),
      JSON.stringify(message.replace(/[\r\n]/g, " ")),
    );
  }
}

async function gate(name: string, payload: object, siteId: string): Promise<string | null> {
  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  const { isHookAbortError } = await import("@justflows/core");
  try {
    await getRuntimeHooks().dispatchGate(name, payload, { siteId, source: "system" });
    return null;
  } catch (err) {
    if (isHookAbortError(err)) return err.message.replace(/[\r\n]/g, " ").slice(0, 300);
    throw err;
  }
}

function eventFor(row: DomainRow): object {
  return {
    siteId: String(row.site_id),
    domainId: String(row.id),
    hostname: String(row.hostname),
    mode: asMode(row.connect_mode) ?? "records",
    provider: row.provider === "bunny" ? "bunny" : "manual",
  };
}

async function siteRows(siteId: string): Promise<DomainRow[]> {
  const db = await getControlDb();
  return db.query<DomainRow>(
    `SELECT ${COLUMNS} FROM site_domains WHERE site_id = ? ORDER BY is_primary DESC, created_at ASC, hostname ASC`,
    [siteId],
  );
}

async function rowById(siteId: string, id: string): Promise<DomainRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getControlDb();
  const rows = await db.query<DomainRow>(
    `SELECT ${COLUMNS} FROM site_domains WHERE id = ? AND site_id = ? LIMIT 1`,
    [id, siteId],
  );
  return rows[0] ?? null;
}

async function childRows(parentId: string): Promise<DomainRow[]> {
  const db = await getControlDb();
  return db.query<DomainRow>(`SELECT ${COLUMNS} FROM site_domains WHERE parent_id = ?`, [parentId]);
}

export async function domainAccess(
  siteId: string,
  settings?: StoredDomainSettings,
): Promise<DomainAccess> {
  const config = settings ?? (await readDomainSettings());
  const modes = (Object.keys(config.modes) as ConnectMode[]).filter((mode) => config.modes[mode]);
  const count = await checkQuota("domains.custom", siteId, { delta: 0 }).catch(() => null);
  const base: DomainAccess = {
    available: config.enabled,
    allowed: false,
    reason: null,
    modes: [],
    limit: count?.limit ?? null,
    used: count?.used ?? 0,
    upgradeUrl: config.upgradeUrl || null,
    provider: config.provider,
    includeWww: config.includeWww,
  };
  if (!config.enabled)
    return { ...base, reason: "Custom domains are not offered on this platform." };
  const feature = await enforceQuota("feature.customDomains", siteId, 0);
  if (feature) return { ...base, reason: feature.error };
  const managed = modes.includes("nameservers")
    ? await enforceQuota("feature.managedDns", siteId, 0)
    : null;
  const allowedModes = modes.filter((mode) => mode !== "nameservers" || !managed);
  return { ...base, allowed: allowedModes.length > 0, modes: allowedModes };
}

export async function listSiteDomains(siteId: string): Promise<SiteDomainView[]> {
  const settings = await readDomainSettings();
  return (await siteRows(siteId)).map((row) => view(row, settings));
}

export interface AddDomainInput {
  hostname: string;
  mode: ConnectMode;
}

/** Normalize and validate a hostname a customer typed. A pasted URL is accepted. */
export function cleanCustomHostname(
  value: string,
  baseDomain: string,
): { ok: true; hostname: string } | { ok: false; error: string } {
  let raw = value.trim().toLowerCase();
  if (/^[a-z]+:\/\//.test(raw)) {
    try {
      raw = new URL(raw).hostname;
    } catch {
      return { ok: false, error: "Enter a domain such as example.com." };
    }
  }
  const hostname = normalizeHostname(raw.split("/")[0] ?? "");
  if (
    !hostname ||
    !isValidHostname(hostname) ||
    !hostname.includes(".") ||
    isLoopbackHost(hostname)
  ) {
    return { ok: false, error: "Enter a domain such as example.com." };
  }
  if (
    /^\d+(\.\d+){3}$/.test(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return { ok: false, error: "Enter a public domain name." };
  }
  if (
    siteDomainKind(hostname, baseDomain) !== "custom" ||
    (baseDomain && hostname === normalizeHostname(baseDomain))
  ) {
    return { ok: false, error: "That address belongs to the platform. Enter a domain you own." };
  }
  return { ok: true, hostname };
}

export async function addCustomDomain(
  siteId: string,
  input: AddDomainInput,
  resolver: DnsResolver = systemResolver(),
): Promise<DomainResult<SiteDomainView[]>> {
  const settings = await readDomainSettings();
  const access = await domainAccess(siteId, settings);
  if (!access.available)
    return fail(403, access.reason ?? "Custom domains are not offered.", "feature_disabled");
  const feature = await enforceQuota("feature.customDomains", siteId, 0);
  if (feature) return fromBlock(feature);
  if (!settings.modes[input.mode])
    return fail(400, "That way of connecting a domain is not offered.");
  if (input.mode === "nameservers") {
    const managed = await enforceQuota("feature.managedDns", siteId, 0);
    if (managed) return fromBlock(managed);
  }
  const count = await enforceQuota("domains.custom", siteId, 1);
  if (count) return fromBlock(count);

  const cleaned = cleanCustomHostname(input.hostname, await platformBaseDomain());
  if (!cleaned.ok) return fail(400, cleaned.error);
  const hostname = cleaned.hostname;
  if (hostname === settings.cnameTarget || settings.nameservers.includes(hostname)) {
    return fail(400, "That address belongs to the platform. Enter a domain you own.");
  }
  if (input.mode === "nameservers" && hostname.startsWith("www.")) {
    return fail(400, "Enter the domain without www. It is added for you.");
  }

  const db = await getControlDb();
  const withWww =
    input.mode === "nameservers" && settings.includeWww
      ? [hostname, `www.${hostname}`]
      : [hostname];
  const taken = await db.query<{ hostname: string }>(
    `SELECT hostname FROM site_domains WHERE hostname IN (${withWww.map(() => "?").join(", ")})`,
    withWww,
  );
  if (taken.some((row) => row.hostname === hostname))
    return fail(409, "That domain is already connected to a website.");
  const hostnames = withWww.filter((name) => !taken.some((row) => row.hostname === name));

  const blocked = await gate("domain.beforeAdd", { siteId, hostname, mode: input.mode }, siteId);
  if (blocked) return fail(403, blocked, "gate_refused");

  const provider = await domainProviderFor(settings);
  let zoneId: string | null = null;
  if (input.mode === "nameservers") {
    if (!provider.hostsZones) return fail(400, "Connecting by nameservers needs Bunny DNS.");
    // Already delegated to the shared nameservers means someone else may own
    // the zone there; ownership has to be proven at the domain's own DNS first.
    const delegated = await checkNameservers(hostname, expectedNameservers(settings), resolver);
    if (delegated.routing) {
      return fail(
        409,
        "This domain already uses the platform's nameservers, so it cannot be verified this way. " +
          "Point it back to its previous DNS provider first, or connect it with DNS records.",
      );
    }
    try {
      const zone = await provider.createZone(hostname, {
        nameservers: settings.nameservers,
        soaEmail: settings.soaEmail,
        serve: hostnames.map((name) => (name === hostname ? "" : "www")),
      });
      zoneId = zone.zoneId;
    } catch (err) {
      return fail(502, shortError(err));
    }
  }

  const parentId = randomUUID();
  const now = stamp();
  try {
    await db.transaction(async (tx) => {
      for (const name of hostnames) {
        const parent = name === hostname;
        await tx.run(
          `INSERT INTO site_domains (id, site_id, hostname, kind, verified, is_primary, created_at, status, connect_mode,
             verification_token, parent_id, provider, dns_zone_id, tls_status, check_failures)
           VALUES (?, ?, ?, 'custom', ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'none', 0)`,
          [
            parent ? parentId : randomUUID(),
            siteId,
            name,
            false,
            false,
            now,
            input.mode,
            parent ? randomBytes(16).toString("hex") : null,
            parent ? null : parentId,
            settings.provider,
            parent ? zoneId : null,
          ],
        );
      }
    });
  } catch (err) {
    if (zoneId) await provider.deleteZone(zoneId).catch(() => undefined);
    const message = err instanceof Error ? err.message : "";
    if (/duplicate|unique/i.test(message))
      return fail(409, "That domain is already connected to a website.");
    throw err;
  }

  const created = await rowById(siteId, parentId);
  if (created) await action("domain.added", eventFor(created), siteId);
  return { ok: true, value: await listSiteDomains(siteId) };
}

/** Make sure a domain's provider side exists and its certificate is there. */
async function activate(
  row: DomainRow,
  provider: DomainProvider,
): Promise<{ tls: TlsStatus; error: string | null }> {
  try {
    await provider.attachHostname(String(row.hostname));
    // From here on, this claim owns the provider-side hostname and may remove it.
    if (!row.provider_attached_at) {
      await (await getControlDb()).run(
        "UPDATE site_domains SET provider_attached_at = ? WHERE id = ? AND provider_attached_at IS NULL",
        [stamp(), String(row.id)],
      );
    }
    const tls = await provider.issueCertificate(String(row.hostname));
    return {
      tls,
      error:
        tls === "pending"
          ? "Waiting for the certificate. DNS can take a while to reach the CDN."
          : null,
    };
  } catch (err) {
    return { tls: "pending", error: shortError(err) };
  }
}

async function dnsCheck(row: DomainRow, settings: StoredDomainSettings, resolver: DnsResolver) {
  if (asMode(row.connect_mode) === "nameservers") {
    // A public lookup decides. Bunny's NameserversDetected flag was seen true
    // while the registry still delegated the domain elsewhere.
    let token = String(row.verification_token ?? "");
    if (!token && !row.ownership_proven_at) {
      // Added before ownership checks existed: issue a challenge now.
      token = randomBytes(16).toString("hex");
      await (await getControlDb()).run("UPDATE site_domains SET verification_token = ? WHERE id = ?", [token, String(row.id)]);
    }
    const check = await checkNameserverDomain(
      {
        hostname: String(row.hostname),
        token,
        expected: expectedNameservers(settings),
        ownershipProven: Boolean(row.ownership_proven_at),
      },
      resolver,
    );
    if (check.provenNow) {
      await (await getControlDb()).run("UPDATE site_domains SET ownership_proven_at = ? WHERE id = ?", [stamp(), String(row.id)]);
    }
    return check;
  }
  return checkRecords(
    {
      hostname: String(row.hostname),
      token: String(row.verification_token ?? ""),
      cnameTarget: settings.cnameTarget,
      apexAddresses: settings.apexAddresses,
    },
    resolver,
  );
}

async function saveCheck(
  row: DomainRow,
  patch: {
    status: DomainStatus;
    verified: boolean;
    tls: TlsStatus;
    error: string | null;
    failures: number;
    verifiedNow: boolean;
  },
): Promise<void> {
  const db = await getControlDb();
  const now = stamp();
  await db.run(
    `UPDATE site_domains SET status = ?, verified = ?, tls_status = ?, last_error = ?, check_failures = ?, checked_at = ?
       ${patch.verifiedNow ? ", verified_at = ?" : ""}
     WHERE id = ?`,
    [
      patch.status,
      patch.verified,
      patch.tls,
      patch.error,
      patch.failures,
      now,
      ...(patch.verifiedNow ? [now] : []),
      String(row.id),
    ],
  );
}

/**
 * One step for a connected domain: check DNS, then attach it and fetch its
 * certificate. An active domain that keeps failing stops being served after
 * the platform's failure threshold.
 */
export async function advanceDomain(
  row: DomainRow,
  settings: StoredDomainSettings,
  provider: DomainProvider,
  resolver: DnsResolver,
): Promise<DomainStatus> {
  if (row.parent_id || String(row.kind) !== "custom" || !asMode(row.connect_mode))
    return asStatus(row.status);
  const before = asStatus(row.status);
  const check = await dnsCheck(row, settings, resolver);
  const children = await childRows(String(row.id));

  if (!check.ownership || !check.routing) {
    const failures = Number(row.check_failures ?? 0) + 1;
    const status: DomainStatus =
      before === "active" && failures < settings.failureThreshold
        ? "active"
        : before === "pending"
          ? "pending"
          : "failed";
    // A pending domain whose DNS no longer checks out is not verified any more.
    const stillVerified = status !== "pending" && asBool(row.verified);
    await saveCheck(row, {
      status,
      verified: stillVerified,
      tls: asTls(row.tls_status),
      error: check.problem,
      failures,
      verifiedNow: false,
    });
    for (const child of children) {
      await saveCheck(child, {
        status: status === "failed" ? "failed" : asStatus(child.status),
        verified: stillVerified && asBool(child.verified),
        tls: asTls(child.tls_status),
        error: check.problem,
        failures,
        verifiedNow: false,
      });
    }
    if (status === "failed" && before !== "failed") {
      await fallBackFromFailed(String(row.site_id), [row, ...children]);
      await action("domain.failed", eventFor(row), String(row.site_id));
    }
    return status;
  }

  const firstVerify = !asBool(row.verified);
  const result =
    asTls(row.tls_status) === "issued" || asTls(row.tls_status) === "external"
      ? { tls: asTls(row.tls_status), error: null }
      : await activate(row, provider);
  const status: DomainStatus =
    result.tls === "issued" || result.tls === "external"
      ? "active"
      : before === "active"
        ? "active"
        : "pending";
  await saveCheck(row, {
    status,
    verified: true,
    tls: result.tls,
    error: result.error,
    failures: 0,
    verifiedNow: firstVerify,
  });
  for (const child of children) {
    const childTls = asTls(child.tls_status);
    const childResult =
      childTls === "issued" || childTls === "external"
        ? { tls: childTls, error: null }
        : await activate(child, provider);
    const childStatus: DomainStatus =
      childResult.tls === "issued" || childResult.tls === "external" ? "active" : "pending";
    await saveCheck(child, {
      status: childStatus,
      verified: true,
      tls: childResult.tls,
      error: childResult.error,
      failures: 0,
      verifiedNow: !asBool(child.verified),
    });
  }
  if (status === "active" && before !== "active")
    await action("domain.activated", eventFor(row), String(row.site_id));
  return status;
}

export async function checkCustomDomain(
  siteId: string,
  id: string,
  resolver: DnsResolver = systemResolver(),
): Promise<DomainResult<SiteDomainView[]>> {
  const row = await rowById(siteId, id);
  if (!row) return fail(404, "That domain was not found.");
  if (row.parent_id) return checkCustomDomain(siteId, String(row.parent_id), resolver);
  if (String(row.kind) !== "custom" || !asMode(row.connect_mode))
    return fail(400, "This address is managed by the platform.");
  const settings = await readDomainSettings();
  const provider = await domainProviderFor(settings);
  await advanceDomain(row, settings, provider, resolver);
  return { ok: true, value: await listSiteDomains(siteId) };
}

/** Remove the provider side of a domain and its `www.` row. Errors are logged, not thrown. */
/**
 * Remove the provider side of a domain and its `www.` row: the hostname from
 * the pull zone and the DNS zone. Every step is tried. Returns the first
 * failure, or null. A hostname or zone that is already gone counts as removed,
 * so a retry after a partial failure finishes the job.
 */
async function releaseAtProvider(
  rows: DomainRow[],
  provider: DomainProvider,
): Promise<string | null> {
  let failure: string | null = null;
  for (const row of rows) {
    if (String(row.kind) !== "custom" || !row.provider) continue;
    // Only detach a hostname this claim attached. A pending or unverified
    // claim never did, and the same hostname may belong to something else at
    // the provider; when in doubt, leave it alone.
    if (row.provider_attached_at) {
      try {
        await provider.detachHostname(String(row.hostname));
      } catch (err) {
        failure ??= shortError(err);
        console.error("[justflows] could not detach domain:", JSON.stringify(shortError(err)));
      }
    }
    if (row.dns_zone_id) {
      try {
        await provider.deleteZone(String(row.dns_zone_id));
      } catch (err) {
        failure ??= shortError(err);
        console.error("[justflows] could not delete DNS zone:", JSON.stringify(shortError(err)));
      }
    }
  }
  return failure;
}

export async function removeCustomDomain(
  siteId: string,
  id: string,
): Promise<DomainResult<SiteDomainView[]>> {
  const row = await rowById(siteId, id);
  if (!row) return fail(404, "That domain was not found.");
  if (String(row.kind) !== "custom") return fail(400, "This address is managed by the platform.");
  const rows = row.parent_id ? [row] : [row, ...(await childRows(String(row.id)))];
  const settings = await readDomainSettings();
  // Keep the domain when the provider refuses, so nothing is left behind there.
  const failure = await releaseAtProvider(rows, await domainProviderFor(settings));
  if (failure) {
    const sentence = /[.!?]$/.test(failure) ? failure : `${failure}.`;
    return fail(502, `The domain was not removed. ${sentence} Try again.`);
  }
  const db = await getControlDb();
  await db.transaction(async (tx) => {
    for (const item of rows)
      await tx.run("DELETE FROM site_domains WHERE id = ? AND site_id = ?", [
        String(item.id),
        siteId,
      ]);
  });
  if (rows.some((item) => asBool(item.is_primary))) await fallBackPrimary(siteId);
  await action("domain.removed", eventFor(row), siteId);
  return { ok: true, value: await listSiteDomains(siteId) };
}

/** Workspace removal: release every custom domain of these sites at the provider. */
export async function releaseSitesAtProvider(siteIds: readonly string[]): Promise<void> {
  if (siteIds.length === 0) return;
  try {
    const db = await getControlDb();
    const rows = await db.query<DomainRow>(
      `SELECT ${COLUMNS} FROM site_domains WHERE kind = 'custom' AND site_id IN (${siteIds.map(() => "?").join(", ")})`,
      [...siteIds],
    );
    if (rows.length === 0) return;
    await releaseAtProvider(rows, await domainProviderFor(await readDomainSettings()));
  } catch (err) {
    console.error(
      "[justflows] could not release custom domains:",
      JSON.stringify(err instanceof Error ? err.message.replace(/[\r\n]/g, " ") : "failed"),
    );
  }
}

function urlFor(hostname: string, currentUrl: string, custom: boolean): string {
  let current: URL | null = null;
  try {
    current = new URL(currentUrl);
  } catch {
    current = null;
  }
  if (custom) return `https://${hostname}`;
  if (
    current &&
    (current.hostname === hostname || hostname.endsWith(".localhost") || isLoopbackHost(hostname))
  ) {
    return `${current.protocol}//${hostname}${current.port ? `:${current.port}` : ""}`;
  }
  return `https://${hostname}`;
}

/** Write `sites.url` on the platform database and, when it has one, the site's own database. */
async function writeSiteUrl(siteId: string, url: string): Promise<void> {
  const db = await getControlDb();
  const now = stamp();
  await db.run("UPDATE sites SET url = ?, updated_at = ? WHERE id = ?", [url, now, siteId]);
  const rows = await db.query<{
    tenant_id: string;
    database_choice: string;
    database_mode: string;
  }>(
    "SELECT s.tenant_id, s.database_choice, t.database_mode FROM sites s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ? LIMIT 1",
    [siteId],
  );
  const site = rows[0];
  if (!site) return;
  const separate = await separateDatabaseForSite(
    String(site.tenant_id),
    siteId,
    String(site.database_choice) as DatabaseChoice,
    (String(site.database_mode) === "separate" ? "separate" : "current") as DatabaseMode,
  );
  if (!separate) return;
  try {
    const client = await borrowSeparateDatabase(separate);
    if (client)
      await client.run("UPDATE sites SET url = ?, updated_at = ? WHERE id = ?", [url, now, siteId]);
  } catch {
    console.error("[justflows] site URL mirror failed");
  }
}

async function makePrimary(siteId: string, row: DomainRow): Promise<void> {
  const db = await getControlDb();
  const sites = await db.query<{ url: string }>("SELECT url FROM sites WHERE id = ? LIMIT 1", [
    siteId,
  ]);
  const url = urlFor(
    String(row.hostname),
    String(sites[0]?.url ?? ""),
    String(row.kind) === "custom",
  );
  await db.transaction(async (tx) => {
    await tx.run("UPDATE site_domains SET is_primary = ? WHERE site_id = ?", [false, siteId]);
    await tx.run("UPDATE site_domains SET is_primary = ? WHERE id = ? AND site_id = ?", [
      true,
      String(row.id),
      siteId,
    ]);
  });
  await writeSiteUrl(siteId, url);
}

/** The best remaining address: the platform's own first, then any active custom domain. */
async function fallBackPrimary(
  siteId: string,
  exclude: ReadonlySet<string> = new Set(),
): Promise<void> {
  const rows = (await siteRows(siteId)).filter(
    (row) => asStatus(row.status) === "active" && !exclude.has(String(row.id)),
  );
  if (rows.some((row) => asBool(row.is_primary))) return;
  const rank = (row: DomainRow) => (row.kind === "subdomain" ? 0 : row.kind === "primary" ? 1 : 2);
  const next = rows.sort((a, b) => rank(a) - rank(b))[0];
  if (next) await makePrimary(siteId, next);
}

async function fallBackFromFailed(siteId: string, failed: DomainRow[]): Promise<void> {
  if (!failed.some((row) => asBool(row.is_primary))) return;
  const db = await getControlDb();
  for (const row of failed)
    await db.run("UPDATE site_domains SET is_primary = ? WHERE id = ?", [false, String(row.id)]);
  await fallBackPrimary(siteId, new Set(failed.map((row) => String(row.id))));
}

export async function setPrimaryDomain(
  siteId: string,
  id: string,
): Promise<DomainResult<SiteDomainView[]>> {
  const row = await rowById(siteId, id);
  if (!row) return fail(404, "That domain was not found.");
  if (asStatus(row.status) !== "active")
    return fail(409, "Only a connected domain can be the primary address.");
  await makePrimary(siteId, row);
  return { ok: true, value: await listSiteDomains(siteId) };
}

// ─── Records in a zone the platform hosts ───────────────────────────────────

async function zoneFor(
  siteId: string,
  id: string,
): Promise<DomainResult<{ row: DomainRow; provider: DomainProvider }>> {
  const row = await rowById(siteId, id);
  if (!row || !row.dns_zone_id) return fail(404, "That domain has no DNS zone here.");
  // Records in the zone only matter once the domain is proven to be theirs.
  if (!row.ownership_proven_at) return fail(409, "Verify that you own this domain before managing its DNS records.");
  const managed = await enforceQuota("feature.managedDns", siteId, 0);
  if (managed) return fromBlock(managed);
  const provider = await domainProviderFor(await readDomainSettings());
  if (!provider.hostsZones) return fail(400, "This installation does not host DNS zones.");
  return { ok: true, value: { row, provider } };
}

export async function listZoneRecords(
  siteId: string,
  id: string,
): Promise<DomainResult<DnsRecord[]>> {
  const zone = await zoneFor(siteId, id);
  if (!zone.ok) return zone;
  try {
    return {
      ok: true,
      value: await zone.value.provider.listRecords(String(zone.value.row.dns_zone_id)),
    };
  } catch (err) {
    return fail(502, shortError(err));
  }
}

export function validateRecordInput(input: {
  type: string;
  name: string;
  value: string;
  ttl?: number;
  priority?: number | null;
}): { ok: true; record: DnsRecordInput } | { ok: false; error: string } {
  if (!(DNS_RECORD_TYPES as readonly string[]).includes(input.type))
    return { ok: false, error: "That record type cannot be added here." };
  const type = input.type as DnsRecordType;
  const name = input.name.trim().toLowerCase().replace(/\.$/, "");
  if (name === "@") return validateRecordInput({ ...input, name: "" });
  if (
    name &&
    !/^(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?)*$/.test(
      name,
    )
  ) {
    return { ok: false, error: "The record name is not valid." };
  }
  if (name.startsWith("_justflows")) return { ok: false, error: "That name is reserved." };
  const value = input.value.trim();
  if (!value || value.length > 2000) return { ok: false, error: "Enter a value." };
  if (type === "A" && !/^(\d{1,3}\.){3}\d{1,3}$/.test(value))
    return { ok: false, error: "An A record needs an IPv4 address." };
  if (type === "AAAA" && !/^[0-9a-f:]{2,39}$/i.test(value))
    return { ok: false, error: "An AAAA record needs an IPv6 address." };
  if ((type === "CNAME" || type === "MX") && !isValidHostname(value.replace(/\.$/, ""))) {
    return { ok: false, error: "Enter a hostname." };
  }
  if (type === "CNAME" && name === "")
    return {
      ok: false,
      error: "The domain itself serves the website. Use another name for a CNAME.",
    };
  const ttl =
    Number.isInteger(input.ttl) && (input.ttl ?? 0) >= 60 && (input.ttl ?? 0) <= 86400
      ? (input.ttl as number)
      : 3600;
  const priority =
    type === "MX" || type === "SRV"
      ? Number.isInteger(input.priority) &&
        (input.priority ?? -1) >= 0 &&
        (input.priority ?? 0) <= 65535
        ? (input.priority as number)
        : 10
      : null;
  return { ok: true, record: { type, name, value, ttl, priority } };
}

export async function addZoneRecord(
  siteId: string,
  id: string,
  input: { type: string; name: string; value: string; ttl?: number; priority?: number | null },
): Promise<DomainResult<DnsRecord[]>> {
  const zone = await zoneFor(siteId, id);
  if (!zone.ok) return zone;
  const checked = validateRecordInput(input);
  if (!checked.ok) return fail(400, checked.error);
  const zoneId = String(zone.value.row.dns_zone_id);
  try {
    const existing = await zone.value.provider.listRecords(zoneId);
    const clash = existing.some(
      (record) =>
        record.managed &&
        record.name === checked.record.name &&
        ["A", "AAAA", "CNAME"].includes(checked.record.type),
    );
    if (clash) return fail(409, "That name serves the website. Pick another name.");
    if (existing.length >= 200) return fail(409, "This zone has reached its record limit.");
    await zone.value.provider.addRecord(zoneId, checked.record);
    return { ok: true, value: await zone.value.provider.listRecords(zoneId) };
  } catch (err) {
    return fail(502, shortError(err));
  }
}

export async function deleteZoneRecord(
  siteId: string,
  id: string,
  recordId: string,
): Promise<DomainResult<DnsRecord[]>> {
  const zone = await zoneFor(siteId, id);
  if (!zone.ok) return zone;
  const zoneId = String(zone.value.row.dns_zone_id);
  try {
    const existing = await zone.value.provider.listRecords(zoneId);
    const record = existing.find((item) => item.id === recordId);
    if (!record) return fail(404, "That record was not found.");
    if (record.managed) return fail(409, "This record serves the website and cannot be removed.");
    await zone.value.provider.deleteRecord(zoneId, recordId);
    return { ok: true, value: await zone.value.provider.listRecords(zoneId) };
  } catch (err) {
    return fail(502, shortError(err));
  }
}

// ─── Background checks ──────────────────────────────────────────────────────

const PENDING_EVERY_MS = 4 * 60 * 1000;
const ACTIVE_EVERY_MS = 6 * 60 * 60 * 1000;
const FAILED_EVERY_MS = 60 * 60 * 1000;

/** Which rows are due. Exported for tests. */
export function dueForCheck(row: Pick<DomainRow, "status" | "checked_at">): boolean {
  const age = ageMs(row.checked_at);
  const status = asStatus(row.status);
  if (status === "pending") return age >= PENDING_EVERY_MS;
  if (status === "failed") return age >= FAILED_EVERY_MS;
  return age >= ACTIVE_EVERY_MS;
}

export async function runDomainChecks(resolver: DnsResolver = systemResolver()): Promise<void> {
  const settings = await readDomainSettings();
  const db = await getControlDb();
  const rows = await db.query<DomainRow>(
    `SELECT ${COLUMNS} FROM site_domains WHERE kind = 'custom' AND parent_id IS NULL AND connect_mode IS NOT NULL`,
  );
  if (rows.length === 0) return;
  const provider = await domainProviderFor(settings);
  const expiryMs = settings.pendingExpiryDays * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    try {
      if (
        asStatus(row.status) === "pending" &&
        !asBool(row.verified) &&
        ageMs(row.created_at) > expiryMs
      ) {
        const children = await childRows(String(row.id));
        // Released only when the provider side is gone too; otherwise the next run retries.
        if (await releaseAtProvider([row, ...children], provider)) continue;
        for (const item of [row, ...children])
          await db.run("DELETE FROM site_domains WHERE id = ?", [String(item.id)]);
        await action("domain.removed", eventFor(row), String(row.site_id));
        continue;
      }
      if (!dueForCheck(row)) continue;
      await advanceDomain(row, settings, provider, resolver);
    } catch (err) {
      console.error(
        "[justflows] domain check failed:",
        JSON.stringify(err instanceof Error ? err.message.replace(/[\r\n]/g, " ") : "failed"),
      );
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startDomainCheckJob(): void {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = true;
    void runDomainChecks().finally(() => {
      running = false;
    });
  };
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
}

/** Reverse proxy question: may a certificate be issued for this hostname? */
export async function tlsAllowed(hostname: string): Promise<boolean> {
  const host = normalizeHostname(hostname);
  if (!host || !isValidHostname(host)) return false;
  const db = await getControlDb();
  const rows = await db.query<{ status: string; verified: unknown; kind: string }>(
    "SELECT status, verified, kind FROM site_domains WHERE hostname = ? LIMIT 1",
    [host],
  );
  const row = rows[0];
  if (!row) return false;
  if (String(row.kind) !== "custom") return asStatus(row.status) === "active";
  return asStatus(row.status) === "active" || asBool(row.verified);
}
