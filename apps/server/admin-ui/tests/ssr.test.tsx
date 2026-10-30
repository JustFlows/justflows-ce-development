// @vitest-environment node

import { describe, expect, it } from "vitest";
import { render } from "../src/entry-server";

const ROUTES = [
  "/install", "/login", "/register", "/forgot-password", "/reset-password",
  "/admin", "/admin/content",
  "/admin/content/new", "/admin/content/example", "/admin/content/example/builder",
  "/admin/content-types", "/admin/media", "/admin/plugins", "/admin/plugins/demo/settings",
  "/admin/plugins/acme.example", "/admin/themes", "/admin/themes/customize",
  "/admin/design", "/admin/menus", "/admin/users", "/admin/settings", "/admin/settings/api", "/admin/comments",
  "/admin/marketplace", "/admin/tools", "/admin/health", "/admin/updates", "/admin/languages",
  "/admin/security", "/admin/security/web-server", "/admin/security/integrity", "/admin/security/header-grade", "/admin/security/headers", "/admin/security/advanced",
  "/admin/security/account", "/admin/security/audit", "/admin/reports",
  "/admin/plugins/justflows.shop", "/admin/plugins/justflows.shop/products",
];

describe("admin SSR routes", () => {
  for (const url of ROUTES) {
    it(`renders ${url} without browser globals`, () => {
      const html = render(url, { url, locale: "en", responses: {} });
      expect(html.length).toBeGreaterThan(20);
    });
  }

  it("renders prefetched content into the initial HTML", () => {
    const html = render("/admin/content", {
      url: "/admin/content",
      locale: "en",
      responses: {
        "/api/languages": {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            languages: [{ code: "en-US", isDefault: true }],
          }),
        },
        "/api/content": {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: [{ id: "1", type: "post", title: "SSR post", slug: "ssr", locale: "en-US", status: "published", updatedAt: "2026-08-26" }] }),
        },
      },
    });
    expect(html).toContain("SSR post");
  });

  it("renders the Security Center from prefetched checks without a site grade", () => {
    const html = render("/admin/security", {
      url: "/admin/security",
      locale: "en",
      responses: {
        "/api/security/center": {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkedAt: "2026-10-29T09:00:00.000Z",
            installationRoot: true,
            auditAvailable: true,
            checks: [
              {
                id: "runtime.debug",
                status: "fail",
                severity: "critical",
                kind: "configuration",
                scope: "installation",
                summary: "productionOn",
                checkedAt: "2026-10-29T09:00:00.000Z",
                href: null,
                evidence: {},
              },
              {
                id: "extensions.integrity",
                status: "unknown",
                severity: "info",
                kind: "configuration",
                scope: "installation",
                summary: "unavailable",
                checkedAt: "2026-10-29T09:00:00.000Z",
                href: null,
                evidence: {},
              },
              {
                id: "recovery.backup",
                status: "unknown",
                severity: "info",
                kind: "configuration",
                scope: "site",
                summary: "notVerified",
                checkedAt: "2026-10-29T09:00:00.000Z",
                href: null,
                evidence: {},
              },
            ],
          }),
        },
      },
    });
    expect(html).toContain("Security Center");
    expect(html).toContain("Debug mode is on while this process is in production.");
    expect(html).toContain("File integrity");
    expect(html).toContain("No backup has been verified");
    expect(html).toContain("Review security events");
    expect(html).not.toContain("Grade");
    expect(html).not.toContain("out of 100");
    expect(html).toContain("Web server setup");
  });

  it("renders the web server file for the host the administrator copies", () => {
    const html = render("/admin/security/web-server", {
      url: "/admin/security/web-server",
      locale: "en",
      responses: {
        "/api/security/web-server": {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            installationRoot: true,
            htaccess: "current",
            accelConfigured: false,
            environments: [
              { id: "nginx", automatic: false, config: "location /uploads/ {\n    proxy_pass http://127.0.0.1:3000;\n}\n" },
              { id: "application", automatic: true, config: null },
            ],
          }),
        },
      },
    });
    expect(html).toContain("Web server");
    expect(html).toContain("nginx");
    expect(html).toContain("proxy_pass http://127.0.0.1:3000;");
    expect(html).toContain("Copy");
    expect(html).toContain("Applied by Justflows");
  });

  it("renders the integrity scan and the rescan action", () => {
    const html = render("/admin/security/integrity", {
      url: "/admin/security/integrity",
      locale: "en",
      responses: {
        "/api/security/integrity": {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            installationRoot: true,
            core: "absent",
            packages: [
              {
                packageId: "acme.demo",
                packageType: "plugin",
                version: "1.0.0",
                status: "modified",
                modified: ["index.js"],
                missing: [],
                unexpected: [],
              },
            ],
          }),
        },
      },
    });
    expect(html).toContain("File integrity");
    expect(html).toContain("acme.demo");
    expect(html).toContain("index.js");
    expect(html).toContain("Scan again");
    expect(html).toContain("This installation has no signed core file manifest");
  });
});
