import { createHmac, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPackageIsTrusted,
  MARKETPLACE_KEYS,
  marketplaceSignPayload,
  verifyMarketplaceSignature,
} from "../../../src/lib/extensions/package-trust.js";

const manifest = { id: "acme.theme", version: "1.0.1", publisher: "acme" };
const digest = "a".repeat(64);
const pinned = "b".repeat(64);
const signing = generateKeyPairSync("ed25519");
const replacement = generateKeyPairSync("ed25519");
const publicPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
const replacementPem = replacement.publicKey.export({ type: "spki", format: "pem" }).toString();

function marketplaceSignature(): string {
  return sign(
    null,
    marketplaceSignPayload(manifest.id, manifest.version, manifest.publisher, digest),
    signing.privateKey,
  ).toString("base64");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertPackageIsTrusted", () => {
  it("accepts an upload whose digest matches the pin", () => {
    vi.stubEnv("JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS", `acme.theme:${digest}`);
    expect(() => assertPackageIsTrusted(manifest, digest)).not.toThrow();
  });

  it("rejects an upload whose digest differs from the pin", () => {
    vi.stubEnv("JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS", `acme.theme:${pinned}`);
    expect(() => assertPackageIsTrusted(manifest, digest)).toThrow(/does not match trusted value/);
  });

  it("still applies the pin when a marketplace signature does not verify", () => {
    vi.stubEnv("JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS", `acme.theme:${pinned}`);
    expect(() =>
      assertPackageIsTrusted(manifest, digest, { marketplaceSignature: "bm90IGEgc2lnbmF0dXJl" }),
    ).toThrow(/does not match trusted value/);
  });

  it("does not accept a signature carried inside the manifest, which cannot cover the archive", () => {
    vi.stubEnv("APP_SECRET", "test-secret");
    vi.stubEnv("JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES", "");
    const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
    const packageSignature = createHmac("sha256", "test-secret").update(canonical).digest("hex");
    for (const archiveDigest of [digest, pinned]) {
      expect(() =>
        assertPackageIsTrusted({ ...manifest, packageSignature }, archiveDigest),
      ).toThrow(/could not be verified/);
    }
  });
});

describe("closed licenses", () => {
  const closed = { ...manifest, license: "LicenseRef-Acme-Commercial" };

  it("are refused on a pinned digest, an unsigned install, or a signature that does not verify", () => {
    vi.stubEnv("JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS", `acme.theme:${digest}`);
    expect(() => assertPackageIsTrusted(closed, digest)).toThrow(/closed license/);
    vi.stubEnv("JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS", "");
    vi.stubEnv("JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES", "1");
    expect(() => assertPackageIsTrusted(closed, digest)).toThrow(/closed license/);
    expect(() => assertPackageIsTrusted(closed, digest, { marketplaceSignature: marketplaceSignature() })).toThrow(
      /closed license/,
    );
  });

  it("leave GPL-compatible packages on the usual pin and unsigned rules", () => {
    vi.stubEnv("JUSTFLOWS_TRUSTED_PACKAGE_DIGESTS", `acme.theme:${digest}`);
    expect(() => assertPackageIsTrusted({ ...manifest, license: "GPL-2.0-or-later" }, digest)).not.toThrow();
  });
});

describe("verifyMarketplaceSignature", () => {
  it("accepts a retiring key during an overlap with its replacement", () => {
    expect(
      verifyMarketplaceSignature(digest, marketplaceSignature(), manifest, [
        replacementPem,
        publicPem,
      ]),
    ).toBe(true);
  });

  it("rejects the retired key after it is removed", () => {
    expect(
      verifyMarketplaceSignature(digest, marketplaceSignature(), manifest, [replacementPem]),
    ).toBe(false);
  });
});

describe("ECDSA P-256 keys and per-type scope (justflows-ce#274)", () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = marketplaceSignPayload(manifest.id, manifest.version, manifest.publisher, digest);
  /** What a KMS returns for ES256: the raw 64-byte r||s value (RFC 7518). */
  const es256 = sign("sha256", payload, { key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  const der = sign("sha256", payload, ec.privateKey).toString("base64");

  it("verifies ES256 signatures in raw and DER form", () => {
    expect(Buffer.from(es256, "base64")).toHaveLength(64);
    expect(verifyMarketplaceSignature(digest, es256, manifest, [ecPem])).toBe(true);
    expect(verifyMarketplaceSignature(digest, der, manifest, [ecPem])).toBe(true);
    expect(verifyMarketplaceSignature(digest, es256, { ...manifest, version: "9.9.9" }, [ecPem])).toBe(false);
  });

  it("uses a scoped key only for its own package types", () => {
    const themeKey = { pem: ecPem, types: ["theme"] as const };
    expect(verifyMarketplaceSignature(digest, es256, manifest, [themeKey], "theme")).toBe(true);
    expect(verifyMarketplaceSignature(digest, es256, manifest, [themeKey], "plugin")).toBe(false);
    expect(verifyMarketplaceSignature(digest, es256, manifest, [themeKey])).toBe(false);
  });

  it("passes the manifest type through when checking a package", () => {
    vi.stubEnv("JUSTFLOWS_ALLOW_UNSIGNED_PACKAGES", "");
    const pluginOnly = { pem: publicPem, types: ["plugin"] as const };
    expect(verifyMarketplaceSignature(digest, marketplaceSignature(), manifest, [pluginOnly], "plugin")).toBe(true);
    expect(verifyMarketplaceSignature(digest, marketplaceSignature(), manifest, [pluginOnly], "theme")).toBe(false);
  });

  it("never trusts other key types, such as RSA or other curves", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    const rsaSig = sign("sha256", payload, rsa.privateKey).toString("base64");
    expect(verifyMarketplaceSignature(digest, rsaSig, manifest, [rsaPem])).toBe(false);
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const p384Pem = p384.publicKey.export({ type: "spki", format: "pem" }).toString();
    const p384Sig = sign("sha384", payload, p384.privateKey).toString("base64");
    expect(verifyMarketplaceSignature(digest, p384Sig, manifest, [p384Pem])).toBe(false);
  });
});

describe("trusted marketplace keys", () => {
  it("are all Ed25519 or ECDSA P-256, and every KMS key is scoped to package types", () => {
    for (const key of MARKETPLACE_KEYS) {
      const parsed = createPublicKey(key.pem);
      const supported =
        parsed.asymmetricKeyType === "ed25519" ||
        (parsed.asymmetricKeyType === "ec" && parsed.asymmetricKeyDetails?.namedCurve === "prime256v1");
      expect(supported).toBe(true);
      if (parsed.asymmetricKeyType === "ec") expect(key.types?.length).toBeGreaterThan(0);
    }
    expect(MARKETPLACE_KEYS.filter((key) => key.types?.includes("theme"))).toHaveLength(1);
  });
});
