/**
 * License validation for Justflows plugins and themes.
 *
 * Core is MIT. Extensions declare their own license. Marketplace listings use
 * a GPL-compatible SPDX identifier. A closed license is the SPDX custom form
 * `LicenseRef-<name>`; core installs such a package only when it carries a
 * valid Justflows Marketplace signature (see `assertPackageIsTrusted`), which
 * the registry gives only to its own packages and to plugins and themes,
 * free or paid, under a closed-source contract.
 */

/** SPDX identifiers and common aliases accepted for marketplace distribution. */
const GPL_COMPATIBLE_IDENTIFIERS = new Set([
  "GPL-2.0",
  "GPL-2.0+",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0",
  "GPL-3.0+",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.1",
  "LGPL-2.1+",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0",
  "LGPL-3.0+",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
]);

const BLOCKED_PATTERN =
  /\b(proprietary|commercial|unlicensed|all rights reserved|closed source|closed-source)\b/i;

/**
 * Returns true when `license` is a GPL-compatible SPDX identifier (or alias).
 * Compound expressions must only contain compatible identifiers joined by OR.
 */
export function isGplCompatibleLicense(license: string | undefined): boolean {
  if (!license?.trim()) return false;

  const value = license.trim();
  if (BLOCKED_PATTERN.test(value)) return false;

  // Collapse whitespace runs first so the split itself needs no `\s+`: a
  // manifest license string with many repeated spaces and no "OR" used to
  // make `\s+OR\s+` backtrack quadratically (js/polynomial-redos) — this is
  // parsed from plugin/theme manifests, which are library input, not code
  // this project controls.
  const parts = value
    .replace(/\s+/g, " ")
    .split(/ OR /i)
    .map((part) => normalizeLicenseToken(part));
  if (parts.length === 0) return false;

  return parts.every((part) => GPL_COMPATIBLE_IDENTIFIERS.has(part));
}

/** SPDX custom license reference, the only accepted way to declare a closed license. */
const CLOSED_LICENSE_RE = /^LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;

/**
 * Returns true for a closed license, written as an SPDX `LicenseRef-<name>`
 * identifier (for example `LicenseRef-Justflows-Proprietary`). Such a package
 * installs only with a valid Marketplace signature.
 */
export function isClosedLicense(license: string | undefined): boolean {
  return typeof license === "string" && CLOSED_LICENSE_RE.test(license.trim());
}

/** A license a manifest may declare: GPL-compatible, or closed (`LicenseRef-<name>`). */
export function isAcceptedManifestLicense(license: string | undefined): boolean {
  return isGplCompatibleLicense(license) || isClosedLicense(license);
}

/** Human-readable error for manifest validation. */
export function gplLicenseValidationMessage(license: string | undefined): string {
  if (!license?.trim()) {
    return "Manifest must declare a GPL-compatible license (e.g. GPL-2.0-or-later)";
  }
  if (BLOCKED_PATTERN.test(license)) {
    return `License "${license}" is not GPL-compatible. Declare a closed license as LicenseRef-<name>; it installs only with a Justflows Marketplace signature.`;
  }
  return `License "${license}" is not recognized as GPL-compatible. Use GPL-2.0-or-later or another GPL-compatible SPDX identifier, or LicenseRef-<name> for a closed license.`;
}

function normalizeLicenseToken(token: string): string {
  return token
    .trim()
    .replace(/[()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-only-only$/i, "-only")
    .replace(/^GNU-/i, "");
}
