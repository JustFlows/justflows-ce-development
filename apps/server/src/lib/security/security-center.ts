// SPDX-License-Identifier: MIT

/**
 * Security Center checks.
 *
 * Each row is one question this process can answer. A pass is that question
 * only. Backups, and a certificate this process did not open, stay unknown.
 * File integrity is a pass only when a signed core manifest matches and every
 * baselined extension matches. Nothing here is folded into a site-wide grade.
 */

export const SECURITY_CHECK_IDS = [
  "runtime.node",
  "runtime.update",
  "runtime.debug",
  "runtime.installer",
  "accounts.mfa",
  "accounts.sessions",
  "accounts.apiKeys",
  "transport.cookies",
  "transport.tls",
  "transport.proxy",
  "headers.policy",
  "extensions.integrity",
  "recovery.backup",
] as const;

export type SecurityCheckId = (typeof SECURITY_CHECK_IDS)[number];
export type CheckStatus = "pass" | "warn" | "fail" | "unknown" | "not_applicable";
export type CheckSeverity = "critical" | "high" | "medium" | "low" | "info";
export type CheckKind = "configuration" | "deployment";
export type CheckScope = "site" | "installation";

export interface SecurityCheck {
  id: SecurityCheckId;
  status: CheckStatus;
  severity: CheckSeverity;
  kind: CheckKind;
  scope: CheckScope;
  summary: string;
  checkedAt: string;
  href: string | null;
  evidence: Record<string, string | number>;
}

export interface SecurityCenterFacts {
  checkedAt: string;
  installationRoot: boolean;
  nodeVersion: string | null;
  minimumNodeMajor: number | null;
  coreVersion: string | null;
  update:
    | { state: "unknown" }
    | { state: "current"; latest: string; checkedAt: string }
    | { state: "available"; latest: string; checkedAt: string };
  debugEnabled: boolean;
  production: boolean;
  installerClosed: boolean;
  mfa: { state: "unknown" } | { state: "known"; admins: number; enrolled: number };
  sessions: { state: "unknown" } | { state: "known"; active: number };
  apiKeys:
    | { state: "unavailable" }
    | { state: "unknown" }
    | { state: "known"; active: number; withoutExpiry: number };
  appUrl: "https" | "http" | "missing";
  /** Same rule as the session cookie: production, or an https APP_URL. */
  cookieSecure: boolean;
  /** Null hides the installation proxy value from a site that is not the platform site. */
  proxy: null | { mode: "bounded" | "wide" | "disabled"; value: string };
  headers:
    | { state: "unavailable" }
    | { state: "unknown" }
    | { state: "killSwitch" }
    | { state: "known"; critical: number; warning: number };
  auditAvailable: boolean;
  integrity:
    | { state: "unknown" }
    | {
        state: "known";
        verified: number;
        unverifiable: number;
        failed: number;
        core: "verified" | "local" | "absent" | "failed";
      };
}

export interface SecurityCenterReport {
  checkedAt: string;
  installationRoot: boolean;
  auditAvailable: boolean;
  checks: SecurityCheck[];
}

const UPDATES_HREF = "/admin/updates";
const ACCOUNT_HREF = "/admin/security/account";
const API_KEYS_HREF = "/admin/settings/api";
const HEADERS_HREF = "/admin/security/headers";

function row(
  facts: SecurityCenterFacts,
  partial: Omit<SecurityCheck, "checkedAt" | "evidence"> & { evidence?: Record<string, string | number> },
): SecurityCheck {
  return {
    checkedAt: facts.checkedAt,
    evidence: partial.evidence ?? {},
    id: partial.id,
    status: partial.status,
    severity: partial.severity,
    kind: partial.kind,
    scope: partial.scope,
    summary: partial.summary,
    href: partial.href,
  };
}

/** Major version from `v22.14.0` or `22.14.0`. */
export function nodeMajor(version: string | null): number | null {
  if (!version) return null;
  const match = /^v?(\d+)\./.exec(version.trim());
  if (!match?.[1]) return null;
  return Number(match[1]);
}

function displayVersion(version: string | null): string {
  const value = version?.trim().replace(/^v/, "") ?? "";
  return value || "unknown";
}

function nodeCheck(facts: SecurityCenterFacts): SecurityCheck {
  const major = nodeMajor(facts.nodeVersion);
  const minimum = facts.minimumNodeMajor;
  const evidence = {
    version: displayVersion(facts.nodeVersion),
    minimum: minimum ?? "unknown",
  };
  if (major === null || minimum === null) {
    return row(facts, {
      id: "runtime.node",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "unknown",
      href: null,
      evidence,
    });
  }
  const supported = major >= minimum;
  return row(facts, {
    id: "runtime.node",
    status: supported ? "pass" : "fail",
    severity: supported ? "info" : "high",
    kind: "configuration",
    scope: "installation",
    summary: supported ? "supported" : "unsupported",
    href: null,
    evidence,
  });
}

function updateCheck(facts: SecurityCenterFacts): SecurityCheck {
  const current = displayVersion(facts.coreVersion);
  if (!facts.installationRoot) {
    return row(facts, {
      id: "runtime.update",
      status: "not_applicable",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "otherSite",
      href: null,
      evidence: { current },
    });
  }
  if (facts.update.state === "unknown") {
    return row(facts, {
      id: "runtime.update",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "unknown",
      href: UPDATES_HREF,
      evidence: { current },
    });
  }
  const available = facts.update.state === "available";
  return row(facts, {
    id: "runtime.update",
    status: available ? "warn" : "pass",
    severity: available ? "high" : "info",
    kind: "configuration",
    scope: "installation",
    summary: facts.update.state,
    href: UPDATES_HREF,
    evidence: { current, latest: facts.update.latest, checked: facts.update.checkedAt },
  });
}

function debugCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (!facts.debugEnabled) {
    return row(facts, {
      id: "runtime.debug",
      status: "pass",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "off",
      href: null,
    });
  }
  if (facts.production) {
    return row(facts, {
      id: "runtime.debug",
      status: "fail",
      severity: "critical",
      kind: "configuration",
      scope: "installation",
      summary: "productionOn",
      href: null,
    });
  }
  return row(facts, {
    id: "runtime.debug",
    status: "not_applicable",
    severity: "info",
    kind: "configuration",
    scope: "installation",
    summary: "developmentOn",
    href: null,
  });
}

function installerCheck(facts: SecurityCenterFacts): SecurityCheck {
  return row(facts, {
    id: "runtime.installer",
    status: facts.installerClosed ? "pass" : "fail",
    severity: facts.installerClosed ? "info" : "critical",
    kind: "configuration",
    scope: "installation",
    summary: facts.installerClosed ? "closed" : "open",
    href: null,
  });
}

function mfaCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (facts.mfa.state === "unknown" || facts.mfa.admins < 1) {
    return row(facts, {
      id: "accounts.mfa",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "unknown",
      href: ACCOUNT_HREF,
      evidence: facts.mfa.state === "known"
        ? { enrolled: facts.mfa.enrolled, admins: facts.mfa.admins }
        : { enrolled: 0, admins: 0 },
    });
  }
  const complete = facts.mfa.enrolled >= facts.mfa.admins;
  return row(facts, {
    id: "accounts.mfa",
    status: complete ? "pass" : "warn",
    severity: complete ? "info" : "high",
    kind: "configuration",
    scope: "site",
    summary: complete ? "all" : "partial",
    href: ACCOUNT_HREF,
    evidence: { enrolled: facts.mfa.enrolled, admins: facts.mfa.admins },
  });
}

function sessionsCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (facts.sessions.state === "unknown") {
    return row(facts, {
      id: "accounts.sessions",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "unknown",
      href: ACCOUNT_HREF,
    });
  }
  return row(facts, {
    id: "accounts.sessions",
    status: "pass",
    severity: "info",
    kind: "configuration",
    scope: "site",
    summary: "known",
    href: ACCOUNT_HREF,
    evidence: { active: facts.sessions.active },
  });
}

function apiKeysCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (facts.apiKeys.state === "unavailable") {
    return row(facts, {
      id: "accounts.apiKeys",
      status: "not_applicable",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "unavailable",
      href: null,
    });
  }
  if (facts.apiKeys.state === "unknown") {
    return row(facts, {
      id: "accounts.apiKeys",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "unknown",
      href: API_KEYS_HREF,
    });
  }
  const { active, withoutExpiry } = facts.apiKeys;
  if (active === 0) {
    return row(facts, {
      id: "accounts.apiKeys",
      status: "pass",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "none",
      href: API_KEYS_HREF,
      evidence: { active, withoutExpiry },
    });
  }
  if (withoutExpiry > 0) {
    return row(facts, {
      id: "accounts.apiKeys",
      status: "warn",
      severity: "medium",
      kind: "configuration",
      scope: "site",
      summary: "openEnded",
      href: API_KEYS_HREF,
      evidence: { active, withoutExpiry },
    });
  }
  return row(facts, {
    id: "accounts.apiKeys",
    status: "pass",
    severity: "info",
    kind: "configuration",
    scope: "site",
    summary: "expiring",
    href: API_KEYS_HREF,
    evidence: { active, withoutExpiry },
  });
}

function cookiesCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (facts.cookieSecure) {
    return row(facts, {
      id: "transport.cookies",
      status: "pass",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "secure",
      href: null,
    });
  }
  if (facts.production) {
    return row(facts, {
      id: "transport.cookies",
      status: "fail",
      severity: "high",
      kind: "configuration",
      scope: "installation",
      summary: "insecureProduction",
      href: null,
    });
  }
  return row(facts, {
    id: "transport.cookies",
    status: "not_applicable",
    severity: "info",
    kind: "configuration",
    scope: "installation",
    summary: "development",
    href: null,
  });
}

function tlsCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (facts.appUrl === "https") {
    return row(facts, {
      id: "transport.tls",
      status: "unknown",
      severity: "info",
      kind: "deployment",
      scope: "installation",
      summary: "notProbed",
      href: null,
    });
  }
  if (facts.appUrl === "http" && facts.production) {
    return row(facts, {
      id: "transport.tls",
      status: "fail",
      severity: "high",
      kind: "configuration",
      scope: "installation",
      summary: "productionHttp",
      href: null,
    });
  }
  if (facts.appUrl === "http") {
    return row(facts, {
      id: "transport.tls",
      status: "not_applicable",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "developmentHttp",
      href: null,
    });
  }
  return row(facts, {
    id: "transport.tls",
    status: facts.production ? "unknown" : "not_applicable",
    severity: "info",
    kind: "configuration",
    scope: "installation",
    summary: "missing",
    href: null,
  });
}

function proxyCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (!facts.proxy) {
    return row(facts, {
      id: "transport.proxy",
      status: "not_applicable",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "otherSite",
      href: null,
    });
  }
  const value = facts.proxy.value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
  if (facts.proxy.mode === "wide") {
    return row(facts, {
      id: "transport.proxy",
      status: "fail",
      severity: "high",
      kind: "configuration",
      scope: "installation",
      summary: "wide",
      href: null,
      evidence: { value },
    });
  }
  if (facts.proxy.mode === "disabled") {
    return row(facts, {
      id: "transport.proxy",
      status: facts.production ? "warn" : "not_applicable",
      severity: facts.production ? "medium" : "info",
      kind: "configuration",
      scope: "installation",
      summary: facts.production ? "disabledProduction" : "disabledDevelopment",
      href: null,
    });
  }
  return row(facts, {
    id: "transport.proxy",
    status: "pass",
    severity: "info",
    kind: "configuration",
    scope: "installation",
    summary: "bounded",
    href: null,
    evidence: { value },
  });
}

function headersCheck(facts: SecurityCenterFacts): SecurityCheck {
  const headers = facts.headers;
  if (headers.state === "unavailable") {
    return row(facts, {
      id: "headers.policy",
      status: "not_applicable",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "unavailable",
      href: null,
    });
  }
  if (headers.state === "unknown") {
    return row(facts, {
      id: "headers.policy",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "site",
      summary: "unknown",
      href: HEADERS_HREF,
    });
  }
  if (headers.state === "killSwitch") {
    return row(facts, {
      id: "headers.policy",
      status: "warn",
      severity: "medium",
      kind: "configuration",
      scope: "site",
      summary: "killSwitch",
      href: HEADERS_HREF,
    });
  }
  const evidence = { critical: headers.critical, warning: headers.warning };
  if (headers.critical > 0) {
    return row(facts, {
      id: "headers.policy",
      status: "fail",
      severity: "high",
      kind: "configuration",
      scope: "site",
      summary: "critical",
      href: HEADERS_HREF,
      evidence,
    });
  }
  if (headers.warning > 0) {
    return row(facts, {
      id: "headers.policy",
      status: "warn",
      severity: "medium",
      kind: "configuration",
      scope: "site",
      summary: "warnings",
      href: HEADERS_HREF,
      evidence,
    });
  }
  return row(facts, {
    id: "headers.policy",
    status: "pass",
    severity: "info",
    kind: "configuration",
    scope: "site",
    summary: "clear",
    href: HEADERS_HREF,
    evidence,
  });
}

const INTEGRITY_HREF = "/admin/security/integrity";

function integrityCheck(facts: SecurityCenterFacts): SecurityCheck {
  if (!facts.installationRoot) {
    return row(facts, {
      id: "extensions.integrity",
      status: "not_applicable",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "otherSite",
      href: null,
    });
  }
  if (facts.integrity.state === "unknown") {
    return row(facts, {
      id: "extensions.integrity",
      status: "unknown",
      severity: "info",
      kind: "configuration",
      scope: "installation",
      summary: "unavailable",
      href: INTEGRITY_HREF,
    });
  }
  const { verified, unverifiable, failed, core } = facts.integrity;
  const evidence = { verified, unverifiable, failed };
  if (failed > 0 || core === "failed") {
    return row(facts, {
      id: "extensions.integrity",
      status: "fail",
      severity: "high",
      kind: "configuration",
      scope: "installation",
      summary: "failed",
      href: INTEGRITY_HREF,
      evidence,
    });
  }
  if (unverifiable > 0 || core === "absent" || core === "local") {
    return row(facts, {
      id: "extensions.integrity",
      status: "warn",
      severity: "medium",
      kind: "configuration",
      scope: "installation",
      summary: "baselineMissing",
      href: INTEGRITY_HREF,
      evidence,
    });
  }
  return row(facts, {
    id: "extensions.integrity",
    status: "pass",
    severity: "info",
    kind: "configuration",
    scope: "installation",
    summary: "clear",
    href: INTEGRITY_HREF,
    evidence,
  });
}

function backupCheck(facts: SecurityCenterFacts): SecurityCheck {
  return row(facts, {
    id: "recovery.backup",
    status: "unknown",
    severity: "info",
    kind: "configuration",
    scope: "site",
    summary: "notVerified",
    href: null,
  });
}

/** Turn a snapshot into checks. Does not read the database or the network. */
export function evaluateSecurityCenter(facts: SecurityCenterFacts): SecurityCheck[] {
  return [
    nodeCheck(facts),
    updateCheck(facts),
    debugCheck(facts),
    installerCheck(facts),
    mfaCheck(facts),
    sessionsCheck(facts),
    apiKeysCheck(facts),
    cookiesCheck(facts),
    tlsCheck(facts),
    proxyCheck(facts),
    headersCheck(facts),
    integrityCheck(facts),
    backupCheck(facts),
  ];
}

export function securityCenterReport(facts: SecurityCenterFacts): SecurityCenterReport {
  const checks = evaluateSecurityCenter(facts);
  return {
    checkedAt: facts.checkedAt,
    installationRoot: facts.installationRoot,
    auditAvailable: facts.auditAvailable,
    checks: facts.installationRoot ? checks : checks.filter((check) => check.scope === "site"),
  };
}
