// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET = "test-secret-that-is-at-least-32-characters-long";

/** Template defaults on `/api/templates` (justflows-ce#301): stored with the template, resolved for content. */

const writes: unknown[] = [];
let stored: { published: unknown[]; draft: unknown[]; publishedDefaults?: Record<string, unknown>; draftDefaults?: Record<string, unknown> } = {
  published: [{ id: "t", type: "core.post-content", version: 1, props: {} }],
  draft: [],
  publishedDefaults: { "core.heading": { textAlign: "center" } },
};

vi.mock("../../../../src/middleware/auth.js", () => ({
  requireRole: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.session = { siteId: "s1", userId: "u1", role: "editor" } as never;
    next();
  },
}));
vi.mock("../../../../src/lib/themes/themes-db.js", () => ({
  getSiteId: async () => "s1",
  getActiveTheme: async () => ({ theme_id: "justflows.default", name: "Default" }),
  themeInstalledPath: () => null,
}));
vi.mock("../../../../src/lib/themes/theme-files.js", () => ({
  loadThemeTemplateDoc: (_t: string, slug: string) => (slug === "page" ? { blocks: [{ id: "x", type: "core.post-content", version: 1, props: {} }], templateDefaults: { "core.paragraph": { padTop: "2" } } } : null),
}));
vi.mock("../../../../src/lib/rendering/template-validate.js", () => ({ validateTemplateBlocks: () => ({ unknownBlockTypes: [] }) }));
vi.mock("../../../../src/lib/security/audit-log.js", () => ({ auditLog: async () => {} }));
vi.mock("../../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async () => {} }));
vi.mock("../../../../src/lib/i18n/languages-db.js", () => ({ getDefaultLocale: async () => "en-US" }));
vi.mock("../../../../src/lib/rendering/header-resolve.js", () => ({
  resolveHeaderConfig: async (input: { ref: string }) => ({ visible: input.ref !== "__none__", layout: "logo-left", blocks: [], showTitle: true }),
}));
vi.mock("../../../../src/lib/rendering/site-header.js", () => ({
  SITE_DEFAULT_HEADER_REF: "__default__",
  getSiteHeaderLibrary: async () => ({ entries: [], defaultId: null }),
  hasSiteHeaderLibraryDraft: async () => false,
}));
vi.mock("../../../../src/lib/rendering/template-render.js", () => ({
  resolveThemePartBlocks: async () => [{ id: "f", type: "core.paragraph", version: 1, props: { text: "Theme footer" } }],
}));
vi.mock("../../../../src/lib/themes/theme-templates-store.js", () => ({
  getStoredTemplate: async (_s: string, _t: string, key: string, draft: boolean) =>
    key === "part-footer" && draft ? [{ id: "fd", type: "core.paragraph", version: 1, props: { text: "Draft footer" } }] : null,
  describeTemplateCandidates: async (_s: string, _t: string, _p: string | null, query: { contentType?: string; slug?: string }) => [
    { slug: `${query.contentType}-${query.slug}`, source: null },
    { slug: query.contentType === "page" ? "page" : "single", source: query.contentType === "page" ? "override" : "theme" },
    { slug: "singular", source: null },
    { slug: "index", source: "theme" },
  ],
  isTemplateSlug: (v: unknown) => typeof v === "string" && /^[a-z0-9-]+$/.test(v),
  listTemplateSlots: async () => [],
  getStoredTemplateDocs: async () => stored,
  getStoredTemplateRevision: async () => 3,
  writeStoredTemplate: async (_s: string, _t: string, slug: string, blocks: unknown, opts: Record<string, unknown>) => {
    writes.push({ slug, blocks, opts });
    const defaults = opts.templateDefaults === undefined ? stored.publishedDefaults : (opts.templateDefaults as Record<string, unknown>);
    return { blocks, revision: 4, ...(defaults && Object.keys(defaults).length ? { templateDefaults: defaults } : {}) };
  },
  clearStoredTemplateDraft: async () => {},
  resetStoredTemplate: async () => {},
  resolveEffectiveTemplate: async (_s: string, _t: string, _p: string | null, query: { kind: string; contentType?: string }) =>
    query.kind === "singular" && query.contentType === "page"
      ? { slug: "page", source: "override", blocks: [{ id: "pc", type: "core.post-content", version: 1, props: {} }], templateDefaults: { "core.heading": { textAlign: "center" } } }
      : { slug: "single", source: "theme", blocks: [] },
}));

const { default: router } = await import("../../../../src/routes/design/templates.js");

let server: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/templates", router);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/templates`;
});
afterAll(() => new Promise((r) => server.close(() => r(null))));
beforeEach(() => {
  writes.length = 0;
});

describe("GET /api/templates/resolve", () => {
  it("returns the template and its defaults for a piece of content", async () => {
    const res = await fetch(`${base}/resolve?contentType=page&slug=about`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ template: { slug: "page", source: "override", templateDefaults: { "core.heading": { textAlign: "center" } } } });
    const post = await (await fetch(`${base}/resolve?contentType=post&slug=hello`)).json();
    expect(post).toEqual({ template: { slug: "single", source: "theme", templateDefaults: {} } });
  });

  it("refuses an invalid content type", async () => {
    expect((await fetch(`${base}/resolve?contentType=..%2Fx`)).status).toBe(400);
  });
});

describe("GET /api/templates/:slug", () => {
  it("includes the stored defaults, and a theme file's defaults when never customised", async () => {
    expect(await (await fetch(`${base}/single`)).json()).toMatchObject({
      templateDefaults: { "core.heading": { textAlign: "center" } },
      publishedTemplateDefaults: { "core.heading": { textAlign: "center" } },
    });
    stored = { published: [], draft: [] };
    expect(await (await fetch(`${base}/page`)).json()).toMatchObject({ fromThemeDefault: true, templateDefaults: { "core.paragraph": { padTop: "2" } } });
  });
});

describe("PUT /api/templates/:slug", () => {
  const put = (body: unknown) =>
    fetch(`${base}/page`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("stores the defaults with the template, keeps them when omitted, and clears them with null", async () => {
    const res = await put({ blocks: [], draft: true, templateDefaults: { "core.heading": { padTop: "4" } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ templateDefaults: { "core.heading": { padTop: "4" } } });
    expect((writes[0] as { opts: Record<string, unknown> }).opts.templateDefaults).toEqual({ "core.heading": { padTop: "4" } });

    await put({ blocks: [], draft: true });
    expect((writes[1] as { opts: Record<string, unknown> }).opts.templateDefaults).toBeUndefined();

    await put({ blocks: [], draft: true, templateDefaults: null });
    expect((writes[2] as { opts: Record<string, unknown> }).opts.templateDefaults).toEqual({});
  });
});

describe("GET /api/templates/resolve?context=1", () => {
  it("adds the template's blocks and hierarchy, the resolved header, and the footer draft", async () => {
    const res = await fetch(`${base}/resolve?context=1&contentType=page&slug=about&headerRef=__default__&locale=en-US`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toMatchObject({
      slug: "page",
      source: "override",
      blocks: [{ type: "core.post-content" }],
      candidates: [
        { slug: "page-about", source: null },
        { slug: "page", source: "override" },
        { slug: "singular", source: null },
        { slug: "index", source: "theme" },
      ],
    });
    expect(body.header).toMatchObject({ ref: "__default__", source: "library", config: { visible: true } });
    expect(body.footer).toEqual({ blocks: [{ id: "fd", type: "core.paragraph", version: 1, props: { text: "Draft footer" } }], source: "override-draft" });
  });

  it("hides the header when the page asks for none, and never reads a visitor session", async () => {
    const body = await (await fetch(`${base}/resolve?context=1&contentType=post&slug=x&headerRef=__none__`)).json();
    expect(body.header.config.visible).toBe(false);
    expect(body.template.slug).toBe("single");
  });
});
