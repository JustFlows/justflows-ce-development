// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import {
  assertListingInstallable,
  marketplaceRequestHeaders,
} from "../../../src/lib/extensions/marketplace-package.js";

const savedToken = process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;

afterEach(() => {
  if (savedToken === undefined) delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
  else process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = savedToken;
});

const comingSoonBeta = {
  id: "justflows.bookings",
  version: "0.1.0",
  registry: {
    listed: true,
    free: true,
    commercialMarketplace: false,
    comingSoon: true,
    beta: true,
  },
};

describe("official platform Marketplace early access", () => {
  it("keeps coming-soon beta listings blocked without the platform token", async () => {
    delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
    await expect(assertListingInstallable(comingSoonBeta, "justflows.bookings", "site-1"))
      .rejects.toMatchObject({ status: 403 });
    expect(marketplaceRequestHeaders()).toEqual({});
  });

  it("authenticates justflows.com and bypasses the prerelease gates", async () => {
    process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = "platform-secret";
    await expect(assertListingInstallable(comingSoonBeta, "justflows.bookings", "site-1"))
      .resolves.toBeUndefined();
    expect(marketplaceRequestHeaders()).toEqual({
      "x-justflows-site-domain": "justflows.com",
      "x-justflows-platform-token": "platform-secret",
    });
  });
});

describe("platform-only Marketplace listings", () => {
  const platformOnly = {
    id: "justflows.partners",
    version: "0.1.0",
    registry: { listed: false, free: true, commercialMarketplace: true },
  };

  it("are not installable without the platform token", async () => {
    delete process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN;
    await expect(assertListingInstallable(platformOnly, "justflows.partners", "site-1"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("are installable on the justflows.com platform", async () => {
    process.env.JUSTFLOWS_PLATFORM_INSTALL_TOKEN = "platform-secret";
    await expect(assertListingInstallable(platformOnly, "justflows.partners", "site-1"))
      .resolves.toBeUndefined();
  });
});
