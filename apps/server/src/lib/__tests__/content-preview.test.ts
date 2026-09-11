// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContentPreview, verifyContentPreview } from "../content-preview.js";
const item = {
  contentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  siteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  version: 3,
};
afterEach(() => vi.unstubAllEnvs());
describe("scoped preview signatures", () => {
  it("roundtrips the exact site, content and version, then expires", () => {
    vi.stubEnv("APP_SECRET", "a-secret-with-at-least-thirty-two-characters");
    const token = createContentPreview(item, 1000);
    expect(verifyContentPreview(token, 1001)).toMatchObject(item);
    expect(verifyContentPreview(token, 1000 + 86_400_000)).toBeNull();
  });
  it("rejects tampering, malformed or oversized tokens and a changed secret", () => {
    vi.stubEnv("APP_SECRET", "a-secret-with-at-least-thirty-two-characters");
    const token = createContentPreview(item);
    expect(verifyContentPreview(`x${token}`)).toBeNull();
    expect(verifyContentPreview("x".repeat(1025))).toBeNull();
    expect(verifyContentPreview({})).toBeNull();
    vi.stubEnv("APP_SECRET", "another-secret-with-at-least-thirty-two-characters");
    expect(verifyContentPreview(token)).toBeNull();
  });
});
