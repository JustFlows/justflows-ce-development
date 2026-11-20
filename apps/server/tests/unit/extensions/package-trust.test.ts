import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPackageIsTrusted,
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
