// SPDX-License-Identifier: MIT

import { promises as dns } from "node:dns";

/** The record a customer adds to prove they own a hostname. */
export const CHALLENGE_PREFIX = "_justflows";
export const CHALLENGE_VALUE_PREFIX = "justflows-verify=";

export function challengeName(hostname: string): string {
  return `${CHALLENGE_PREFIX}.${hostname}`;
}

export function challengeValue(token: string): string {
  return `${CHALLENGE_VALUE_PREFIX}${token}`;
}

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveNs(name: string): Promise<string[]>;
}

/** Public resolvers, so a stale answer cached on this host does not decide. */
export function systemResolver(): DnsResolver {
  const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
  try {
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  } catch {
    // Keep the system servers.
  }
  return resolver;
}

async function safe<T>(lookup: Promise<T>, fallback: T): Promise<T> {
  try {
    return await lookup;
  } catch {
    return fallback;
  }
}

function clean(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

export interface RecordsCheckInput {
  hostname: string;
  token: string;
  cnameTarget: string;
  apexAddresses: readonly string[];
}

export interface DnsCheckResult {
  ownership: boolean;
  routing: boolean;
  /** Why the check did not pass, for the site admin. Empty when it passed. */
  problem: string;
}

/**
 * Records mode: the TXT challenge proves ownership, and the hostname has to
 * reach the platform — a CNAME to the target, or addresses that match the
 * target's (a flattened apex) or the configured apex addresses.
 */
export async function checkRecords(
  input: RecordsCheckInput,
  resolver: DnsResolver,
): Promise<DnsCheckResult> {
  const txt = await safe(resolver.resolveTxt(challengeName(input.hostname)), [] as string[][]);
  const expected = challengeValue(input.token);
  const ownership = txt.some((chunks) => chunks.join("").trim() === expected);

  const target = clean(input.cnameTarget);
  const cnames = (await safe(resolver.resolveCname(input.hostname), [] as string[])).map(clean);
  let routing = Boolean(target) && cnames.includes(target);
  if (!routing) {
    const [own4, own6] = await Promise.all([
      safe(resolver.resolve4(input.hostname), [] as string[]),
      safe(resolver.resolve6(input.hostname), [] as string[]),
    ]);
    const own = new Set([...own4, ...own6].map((ip) => ip.toLowerCase()));
    const allowed = new Set(input.apexAddresses.map((ip) => ip.toLowerCase()));
    if (target) {
      const [t4, t6] = await Promise.all([
        safe(resolver.resolve4(target), [] as string[]),
        safe(resolver.resolve6(target), [] as string[]),
      ]);
      for (const ip of [...t4, ...t6]) allowed.add(ip.toLowerCase());
    }
    routing = own.size > 0 && [...own].some((ip) => allowed.has(ip));
  }

  let problem = "";
  if (!ownership) problem = `The TXT record ${challengeName(input.hostname)} was not found yet.`;
  else if (!routing)
    problem = `${input.hostname} does not point at ${target || "this platform"} yet.`;
  return { ownership, routing, problem };
}

/** Whether the domain's public NS set is the expected one. Delegation alone never proves ownership. */
export async function checkNameservers(
  hostname: string,
  expected: readonly string[],
  resolver: DnsResolver,
): Promise<DnsCheckResult> {
  const found = new Set((await safe(resolver.resolveNs(hostname), [] as string[])).map(clean));
  const wanted = expected.map(clean).filter(Boolean);
  const ok = wanted.length > 0 && wanted.every((ns) => found.has(ns));
  return {
    ownership: false,
    routing: ok,
    problem: ok ? "" : `The nameservers of ${hostname} are not ${wanted.join(" and ")} yet.`,
  };
}

export async function hasChallenge(hostname: string, token: string, resolver: DnsResolver): Promise<boolean> {
  if (!token) return false;
  const txt = await safe(resolver.resolveTxt(challengeName(hostname)), [] as string[][]);
  const expected = challengeValue(token);
  return txt.some((chunks) => chunks.join("").trim() === expected);
}

export interface NameserverDomainInput {
  hostname: string;
  token: string;
  expected: readonly string[];
  /** Ownership was already proven on an earlier check. */
  ownershipProven: boolean;
}

/**
 * Nameservers mode: delegation routes the domain but never proves ownership.
 * The exact TXT challenge proves ownership before or after delegation. The
 * platform must not publish that challenge or allow unverified DNS edits.
 */
export async function checkNameserverDomain(
  input: NameserverDomainInput,
  resolver: DnsResolver,
): Promise<DnsCheckResult & { provenNow: boolean }> {
  const delegation = await checkNameservers(input.hostname, input.expected, resolver);
  let ownership = input.ownershipProven;
  let provenNow = false;
  if (!ownership && (await hasChallenge(input.hostname, input.token, resolver))) {
    ownership = true;
    provenNow = true;
  }
  let problem = "";
  if (!ownership) {
    problem = `The TXT record ${challengeName(input.hostname)} with the expected verification value was not found yet. Add it at the domain's authoritative DNS provider.`;
  } else if (!delegation.routing) {
    problem = delegation.problem;
  }
  return { ownership, routing: delegation.routing, problem, provenNow };
}
