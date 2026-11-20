import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { isClosedLicense } from "@justflows/sdk";

function readTrustedDigests(): Map<string, string> {
  const raw = process.env.JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS ?? "";
  const map = new Map<string, string>();
  for (const part of raw.split(",")) {
    const [id, digest] = part.split(":").map((s) => s.trim());
    if (id && digest) map.set(id, digest.toLowerCase());
  }
  return map;
}

/**
 * Package authenticity is required by default as of 0.1.2. Installing a package
 * runs its code in this process, so an unverified upload is equivalent to shell
 * access — that has to be a deliberate choice, not the path of least resistance.
 *
 * `JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1` opts out, for local development and for
 * operators who build their own packages and accept the risk.
 * `JUSTFLOWS_REQUIRE_SIGNED_PACKAGES=1` is kept as a no-op alias so existing
 * hardened deployments do not break; it can be removed once 0.1.x is retired.
 */
export function allowUnsignedPackages(): boolean {
  if (process.env.JUSTFLOWS_REQUIRE_SIGNED_PACKAGES === "1") return false;
  return process.env.JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES === "1";
}

/** Package types a marketplace key may sign. */
export type MarketplacePackageType = "plugin" | "theme" | "css-provider";

/**
 * A trusted marketplace public key (SPKI PEM): Ed25519, or ECDSA P-256 for
 * keys held in a KMS that signs with ES256 (justflows-ce#274). `types` limits
 * the key to the package types its registry publishes, so the theme key can
 * never vouch for a plugin. A key without `types` vouches for every type.
 */
export interface MarketplaceKey {
  readonly pem: string;
  readonly types?: readonly MarketplacePackageType[];
}

/**
 * Keys this core trusts for Marketplace signatures. During a key change both
 * the retiring and the new keys are listed; the retiring key is removed in a
 * later release. See docs/EXTENSION-TRUST.md, "Marketplace signing keys".
 */
export const MARKETPLACE_KEYS: readonly MarketplaceKey[] = [
  {
    /** The original Ed25519 key, shared by both registries. Retiring (#274). */
    pem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2XeYyQg1/VM9A+y2Xh7Yw9+XYHBK6y7gUuOC6NVLZrw=
-----END PUBLIC KEY-----`,
  },
];

/** PEMs of {@link MARKETPLACE_KEYS}, for callers that only need the key material. */
export const MARKETPLACE_PUBLIC_KEYS: readonly string[] = MARKETPLACE_KEYS.map((key) => key.pem);

export function marketplaceSignPayload(
  id: string,
  version: string,
  publisher: string,
  digestHex: string,
): Buffer {
  return Buffer.from(`${id}\n${version}\n${publisher}\n${digestHex.toLowerCase()}`, "utf8");
}

/**
 * Checks one signature against one key. Ed25519 signs the payload directly;
 * ECDSA P-256 (ES256) signs its SHA-256, as a raw 64-byte r||s value (RFC 7518)
 * or DER. Other key types are never trusted.
 */
function verifyWithKey(payload: Buffer, signature: Buffer, pem: string): boolean {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType === "ed25519") return verifySignature(null, payload, key, signature);
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") {
    const dsaEncoding = signature.length === 64 ? "ieee-p1363" : "der";
    return verifySignature("sha256", payload, { key, dsaEncoding }, signature);
  }
  return false;
}

export function verifyMarketplaceSignature(
  digestHex: string,
  signatureB64: string,
  bind?: { id: string; version: string; publisher: string },
  publicKeys: readonly (string | MarketplaceKey)[] = MARKETPLACE_KEYS,
  packageType?: string,
): boolean {
  if (!digestHex || !signatureB64) return false;

  const payload = bind
    ? marketplaceSignPayload(bind.id, bind.version, bind.publisher, digestHex)
    : Buffer.from(digestHex.toLowerCase(), "hex");
  const signature = Buffer.from(signatureB64, "base64");
  for (const entry of publicKeys) {
    const key: MarketplaceKey = typeof entry === "string" ? { pem: entry } : entry;
    /** A key scoped to other package types, or an unknown type, cannot vouch for this one. */
    if (key.types && !(key.types as readonly string[]).includes(packageType ?? "")) continue;
    try {
      if (verifyWithKey(payload, signature, key.pem)) return true;
    } catch {
      /** Ignore an invalid or retired key and try the remaining trusted keys. */
    }
  }
  return false;
}

export interface PackageTrustOptions {
  marketplaceSignature?: string;
}

/** Reject untrusted package uploads unless digest or signature checks pass. */
export function assertPackageIsTrusted(
  manifest: Record<string, unknown>,
  digest: string,
  options?: PackageTrustOptions,
): void {
  const packageId = typeof manifest.id === "string" ? manifest.id : "";

  // A marketplace signature is publisher proof and outranks a local pin. Checked
  // first so a digest pinned for an earlier manual upload of the same id cannot
  // block a newer, properly signed marketplace release.
  if (options?.marketplaceSignature) {
    const version = typeof manifest.version === "string" ? manifest.version : "";
    const publisher = typeof manifest.publisher === "string" ? manifest.publisher : "";
    if (
      verifyMarketplaceSignature(
        digest,
        options.marketplaceSignature,
        { id: packageId, version, publisher },
        MARKETPLACE_KEYS,
        typeof manifest.type === "string" ? manifest.type : "plugin",
      )
    ) {
      return;
    }
  }

  /**
   * A closed license (`LicenseRef-<name>`) is accepted only on the Marketplace
   * signature above: the registry signs one only for Justflows' own packages
   * and for plugins and themes, free or paid, under a closed-source contract.
   * A pinned digest or an unsigned
   * install cannot vouch for it.
   */
  if (isClosedLicense(typeof manifest.license === "string" ? manifest.license : undefined)) {
    throw new Error(
      `"${packageId || "This package"}" has a closed license (${String(manifest.license)}). ` +
        "Closed-source extensions install only from the Justflows Marketplace, with a valid Marketplace signature.",
    );
  }

  const trusted = readTrustedDigests();
  if (packageId && trusted.has(packageId)) {
    if (trusted.get(packageId) !== digest.toLowerCase()) {
      throw new Error(`Package digest does not match trusted value for ${packageId}`);
    }
    return;
  }

  // A signature carried inside the manifest is deliberately not accepted: the
  // manifest is part of the archive, so it can never vouch for the archive's
  // other files. Only a pinned digest or a marketplace signature over the
  // archive digest proves the bytes.

  if (allowUnsignedPackages()) {
    console.warn(
      `[justflows] SECURITY: installing unverified package "${packageId || "unknown"}" ` +
        `(digest ${digest.slice(0, 12)}…). JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES is set.`,
    );
    return;
  }

  throw new Error(
    "This package could not be verified. Installing a package runs its code on your server, " +
      "so Justflows only accepts packages that carry a valid marketplace signature or whose " +
      "SHA-256 digest you have pinned.\n\n" +
      `Digest of the package you uploaded: ${digest}\n\n` +
      "To install it anyway, either pin it:\n" +
      `  JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS=${packageId || "<package-id>"}:${digest}\n` +
      "or, if you build your own packages and accept the risk, allow unsigned installs:\n" +
      "  JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES=1",
  );
}

/**
 * Justflows core release Ed25519 public keys (SPKI PEM). Every official
 * `justflows.zip` is published with a `justflows.zip.sig` made by the matching
 * private key (`scripts/sign-core-release.mjs`). This is a separate key from the
 * marketplace one, so a compromised registry cannot sign a core update.
 *
 * A list so a key can be rotated: ship the new key next to the old one for one
 * release, then drop the old one.
 */
export const CORE_RELEASE_PUBLIC_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAuVVJOPaJYnkAKdgzbowWBSlvFhBnFzL+W/zgq+jH9+c=
-----END PUBLIC KEY-----`,
];

/** Bytes a core release signature covers. Binds the version so an older signed
 * build cannot be passed off as a newer one. */
export function coreReleaseSignPayload(version: string, digestHex: string): Buffer {
  return Buffer.from(`justflows-core\n${version}\n${digestHex.toLowerCase()}`, "utf8");
}

export function verifyCoreReleaseSignature(
  digestHex: string,
  version: string,
  signatureB64: string | undefined,
  publicKeys: readonly string[] = CORE_RELEASE_PUBLIC_KEYS,
): boolean {
  if (!digestHex || !version || !signatureB64?.trim()) return false;
  const payload = coreReleaseSignPayload(version, digestHex);
  const signature = Buffer.from(signatureB64.trim(), "base64");
  for (const pem of publicKeys) {
    try {
      if (verifySignature(null, payload, createPublicKey(pem), signature)) return true;
    } catch {
      /* try the next key */
    }
  }
  return false;
}

/**
 * Core updates must be verified by default. `JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES=1`
 * opts out, for local development and for operators who build their own core.
 */
export function allowUnsignedCoreUpdates(): boolean {
  return process.env.JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES === "1";
}

function verifyUpdateHmac(buffer: Buffer, key: string, signature: string | undefined): boolean {
  if (!signature?.trim()) return false;
  const expected = createHmac("sha256", key).update(buffer).digest("hex");
  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CoreUpdateTrustInput {
  buffer: Buffer;
  digest: string;
  /** Version read from the archive's own package.json. */
  version: string;
  /** Ed25519 signature published with an official release (base64). */
  releaseSignature?: string;
  /** Operator HMAC made with JUSTFLOWS_UPDATE_SIGNING_KEY (hex). */
  signature?: string;
}

/**
 * Refuse a core update archive nobody vouched for. Replacing the core runs new
 * code in this process, so this is the same bar as installing a package.
 *
 * Accepted, in order: an operator-pinned `JUSTFLOWS_UPDATE_DIGEST` (a mismatch
 * always fails), an official Justflows release signature, or an operator HMAC
 * made with `JUSTFLOWS_UPDATE_SIGNING_KEY`. Returns how the archive was verified.
 */
export function assertCoreUpdateIsTrusted(
  input: CoreUpdateTrustInput,
  publicKeys: readonly string[] = CORE_RELEASE_PUBLIC_KEYS,
): string {
  const digest = input.digest.toLowerCase();

  const pinned = process.env.JUSTFLOWS_UPDATE_DIGEST?.trim().toLowerCase();
  if (pinned) {
    if (digest !== pinned) throw new Error("Update digest does not match JUSTFLOWS_UPDATE_DIGEST");
    return "Digest matches JUSTFLOWS_UPDATE_DIGEST";
  }

  if (verifyCoreReleaseSignature(digest, input.version, input.releaseSignature, publicKeys)) {
    return `Justflows release signature verified (v${input.version})`;
  }

  const hmacKey = process.env.JUSTFLOWS_UPDATE_SIGNING_KEY;
  if (hmacKey && verifyUpdateHmac(input.buffer, hmacKey, input.signature)) {
    return "Update signature verified (JUSTFLOWS_UPDATE_SIGNING_KEY)";
  }

  if (input.releaseSignature?.trim()) {
    throw new Error(
      `The Justflows release signature does not match this archive (v${input.version}). ` +
        "Download justflows.zip and justflows.zip.sig from the same release and try again.",
    );
  }
  if (hmacKey && input.signature?.trim()) {
    throw new Error("Core update signature is invalid");
  }

  if (allowUnsignedCoreUpdates()) {
    console.warn(
      "[justflows] SECURITY: applying an unverified core update. JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES is set.",
      JSON.stringify({ version: input.version, digest }),
    );
    return "Unverified — JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES is set";
  }

  throw new Error(
    "This core update could not be verified. Updating the core runs its code on your server, " +
      "so Justflows only applies an official release together with its signature " +
      "(justflows.zip.sig, published next to justflows.zip on every release).\n\n" +
      `Digest of the archive you supplied: ${digest}\n\n` +
      "To apply your own build instead, pin it:\n" +
      `  JUSTFLOWS_UPDATE_DIGEST=${digest}\n` +
      "or, if you build your own core and accept the risk, allow unsigned updates:\n" +
      "  JUSTFLOWS_ALLOW_UNSIGNED_CORE_UPDATES=1",
  );
}
