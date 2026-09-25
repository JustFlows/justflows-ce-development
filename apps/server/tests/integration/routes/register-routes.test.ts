// SPDX-License-Identifier: MIT

import express from "express";
import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_PATH_RE, isAdminSpaDocument } from "../../../src/register-routes.js";

describe("admin SPA route matching", () => {
  it.each(["/admin", "/admin/", "/admin/content", "/admin/content/new"])(
    "serves the SPA document for %s",
    (pathname) => {
      expect(ADMIN_PAGE_PATH_RE.test(pathname)).toBe(true);
    },
  );

  it.each(["/administrator", "/api/admin", "/"])("does not claim %s", (pathname) => {
    expect(ADMIN_PAGE_PATH_RE.test(pathname)).toBe(false);
  });

  it("serves the shop namespace root even though the plugin id contains a dot", () => {
    expect(isAdminSpaDocument("/admin/plugins/justflows.shop")).toBe(true);
    expect(isAdminSpaDocument("/admin/plugins/justflows.shop/attributes")).toBe(true);
    expect(isAdminSpaDocument("/admin/assets/index-abc123.js")).toBe(false);
    expect(isAdminSpaDocument("/admin/plugins/justflows.shop/admin/attributes.css")).toBe(false);
  });
});

describe("/jf-plugins.<hash>.<ext> bundle route", () => {
  // Regression: Express 5 exposes RegExp captures as an object ({ "0": …,
  // "1": … }), not an array, so array-destructuring `req.params` throws and the
  // handler's catch turns every bundle request into a 404. The handler must
  // index the captures instead.
  const BUNDLE_RE = /^\/jf-plugins\.([0-9a-f]{6,40})\.(js|css)$/;

  it("extracts hash and ext by index from Express 5 req.params", async () => {
    const app = express();
    let seen: { hash: string; ext: string } | null = null;
    app.get(BUNDLE_RE, (req, res) => {
      const params = req.params as unknown as string[];
      seen = { hash: params[0] ?? "", ext: (params[1] ?? "js") as string };
      res.end();
    });

    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      await fetch(`http://localhost:${port}/jf-plugins.2be45ccd9c2478f4.js`);
    } finally {
      server.close();
    }

    expect(seen).toEqual({ hash: "2be45ccd9c2478f4", ext: "js" });
  });
});
