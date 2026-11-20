import { describe, expect, it } from "vitest";
import {
  gplLicenseValidationMessage,
  isAcceptedManifestLicense,
  isClosedLicense,
  isGplCompatibleLicense,
} from "../../src/license.js";

describe("isGplCompatibleLicense", () => {
  it("accepts recommended Justflows license", () => {
    expect(isGplCompatibleLicense("GPL-2.0-or-later")).toBe(true);
  });

  it("accepts MIT as GPL-compatible", () => {
    expect(isGplCompatibleLicense("MIT")).toBe(true);
  });

  it("accepts compound OR expressions when all parts are compatible", () => {
    expect(isGplCompatibleLicense("GPL-2.0-or-later OR MIT")).toBe(true);
  });

  it("rejects missing license", () => {
    expect(isGplCompatibleLicense(undefined)).toBe(false);
    expect(isGplCompatibleLicense("")).toBe(false);
  });

  it("rejects proprietary licenses", () => {
    expect(isGplCompatibleLicense("Proprietary")).toBe(false);
    expect(isGplCompatibleLicense("Commercial")).toBe(false);
  });

  it("provides helpful validation messages", () => {
    expect(gplLicenseValidationMessage(undefined)).toContain("GPL-compatible");
    expect(gplLicenseValidationMessage("Proprietary")).toContain("Proprietary");
  });
});

describe("closed licenses", () => {
  it("accepts only the SPDX LicenseRef-<name> form", () => {
    expect(isClosedLicense("LicenseRef-Justflows-Proprietary")).toBe(true);
    expect(isClosedLicense("LicenseRef-Acme.Commercial-2")).toBe(true);
    expect(isClosedLicense("Proprietary")).toBe(false);
    expect(isClosedLicense("LicenseRef-")).toBe(false);
    expect(isClosedLicense("LicenseRef-a b")).toBe(false);
    expect(isClosedLicense("MIT OR LicenseRef-Acme")).toBe(false);
  });

  it("is an accepted manifest license, next to the GPL-compatible ones", () => {
    expect(isAcceptedManifestLicense("LicenseRef-Acme")).toBe(true);
    expect(isAcceptedManifestLicense("GPL-2.0-or-later")).toBe(true);
    expect(isAcceptedManifestLicense("All rights reserved")).toBe(false);
    expect(isGplCompatibleLicense("LicenseRef-Acme")).toBe(false);
  });
});

