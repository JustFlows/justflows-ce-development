// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ANONYMOUS_VIEWER } from "@justflows/content";

const mocks = vi.hoisted(() => ({
  cookie: null as unknown,
  session: null as unknown,
  sameSite: true,
  access: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("../../../src/lib/auth/session.js", () => ({ getSession: () => mocks.cookie }));
vi.mock("../../../src/lib/auth/auth-session.js", () => ({ resolveSession: mocks.resolve }));
vi.mock("../../../src/lib/tenancy/access.js", () => ({ sessionMatchesRequestSite: () => mocks.sameSite }));
vi.mock("../../../src/lib/auth/access-policy.js", () => ({ getEffectiveAccess: mocks.access }));

import { currentVisibilityViewer, visibilityRequestContext, visibilityRequestMemo } from "../../../src/lib/content/visibility-viewer.js";

const inRequest = <T,>(work: () => Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    visibilityRequestContext({} as Request, {} as Response, () => {
      work().then(resolve, reject);
    });
  });

beforeEach(() => {
  mocks.cookie = { userId: "u" };
  mocks.session = { userId: "u", siteId: "s", role: "subscriber" };
  mocks.sameSite = true;
  mocks.resolve.mockReset().mockImplementation(async () => mocks.session);
  mocks.access.mockReset().mockResolvedValue({ roleId: "subscriber", additionalRoles: [] });
});

describe("visibility viewer", () => {
  it("treats code outside a request as anonymous", async () => {
    await expect(currentVisibilityViewer()).resolves.toBe(ANONYMOUS_VIEWER);
    expect(visibilityRequestMemo()).toBeUndefined();
  });

  it("does no session work for a visitor without a cookie", async () => {
    mocks.cookie = null;
    await expect(inRequest(currentVisibilityViewer)).resolves.toBe(ANONYMOUS_VIEWER);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("reads the custom primary role and additional roles, not only the user row", async () => {
    mocks.access.mockResolvedValue({ roleId: "custom-role-id", additionalRoles: ["customer"] });
    await expect(inRequest(currentVisibilityViewer)).resolves.toEqual({
      userId: "u",
      roles: ["custom-role-id", "customer"],
      authenticated: true,
    });
  });

  it("treats a revoked session, another site's session, and a failed lookup as anonymous", async () => {
    mocks.session = null;
    await expect(inRequest(currentVisibilityViewer)).resolves.toBe(ANONYMOUS_VIEWER);
    mocks.session = { userId: "u", siteId: "other", role: "administrator" };
    mocks.sameSite = false;
    await expect(inRequest(currentVisibilityViewer)).resolves.toBe(ANONYMOUS_VIEWER);
    mocks.sameSite = true;
    mocks.access.mockRejectedValue(new Error("down"));
    await expect(inRequest(currentVisibilityViewer)).resolves.toBe(ANONYMOUS_VIEWER);
  });

  it("resolves the viewer once per request", async () => {
    await inRequest(async () => {
      await currentVisibilityViewer();
      await currentVisibilityViewer();
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });
});
