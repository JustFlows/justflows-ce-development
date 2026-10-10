// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { MANAGE_API_OPENAPI } from "../../../src/lib/http/openapi-manage.js";

describe("MANAGE_API_OPENAPI", () => {
  it("is an OpenAPI 3.1 document served under /api/manage/v1", () => {
    expect(MANAGE_API_OPENAPI.openapi).toBe("3.1.0");
    expect(MANAGE_API_OPENAPI.servers[0]?.url).toBe("/api/manage/v1");
  });

  it("declares the bearerAuth scheme and applies it globally", () => {
    expect(MANAGE_API_OPENAPI.components.securitySchemes.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    expect(MANAGE_API_OPENAPI.security).toEqual([{ bearerAuth: [] }]);
  });

  it("annotates every operation with the capability it requires", () => {
    const ops = Object.values(MANAGE_API_OPENAPI.paths).flatMap((path) => Object.values(path));
    expect(ops.length).toBeGreaterThan(30);
    for (const op of ops) {
      expect(typeof (op as { "x-required-capability"?: unknown })["x-required-capability"]).toBe(
        "string",
      );
      const responses = (op as { responses: Record<string, unknown> }).responses;
      expect(responses).toHaveProperty("401");
      expect(responses).toHaveProperty("403");
      expect(responses).toHaveProperty("429");
    }
  });

  it("covers content, media, users, settings, events and self-webhooks", () => {
    const paths = Object.keys(MANAGE_API_OPENAPI.paths);
    for (const p of [
      "/content",
      "/content/{id}/publish",
      "/media",
      "/comments",
      "/users",
      "/roles",
      "/settings",
      "/menus",
      "/content-types",
      "/languages",
      "/redirects",
      "/plugins/{id}/activate",
      "/themes/{id}/activate",
      "/headers",
      "/template-parts/{part}",
      "/widgets",
      "/widgets/areas/{key}",
      "/themes/customize",
      "/permalinks",
      "/email-templates",
      "/events",
      "/webhooks",
      "/health",
    ]) {
      expect(paths).toContain(p);
    }
  });
});
