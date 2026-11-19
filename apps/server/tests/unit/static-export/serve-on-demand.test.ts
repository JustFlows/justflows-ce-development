// SPDX-License-Identifier: MIT
import { Writable } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryFiles, memoryStore } from "./on-demand-memory.js";

const SITE = "site-a";

const mocks = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  session: vi.fn(),
  fetch: vi.fn(),
  closed: vi.fn(),
  purge: vi.fn(),
  memory: null as unknown as ReturnType<typeof import("./on-demand-memory.js").memoryStore>,
  files: null as unknown as ReturnType<typeof import("./on-demand-memory.js").memoryFiles>,
}));

vi.mock("../../../src/middleware/account-cache.js", () => ({ isAccountPath: () => false }));
vi.mock("../../../src/lib/auth/session.js", () => ({ getSession: mocks.session }));
vi.mock("../../../src/lib/admin/admin-path.js", () => ({
  getAdminPathConfig: async () => ({ path: "/secret-admin" }),
}));
vi.mock("../../../src/lib/settings/site-settings.js", () => ({ getSiteId: async () => SITE }));
vi.mock("../../../src/lib/settings/site-visibility.js", () => ({ isSiteClosed: mocks.closed }));
vi.mock("../../../src/lib/tenancy/context.js", () => ({ getTenantContext: () => null }));
vi.mock("../../../src/lib/static-export/config.js", () => ({
  getStaticExportConfig: () => mocks.cfg,
  noteListenerPort: () => undefined,
  siteLoopbackOrigin: (port: number) => `http://127.0.0.1:${port}`,
  STATIC_EXPORT_HEADER: "x-jf-static-export",
}));
vi.mock("../../../src/lib/static-export/discover.js", () => ({
  NOT_FOUND_PROBE: "/__justflows_static_export_404__",
}));
vi.mock("../../../src/lib/static-export/exclusions.js", () => ({ CORE_DYNAMIC_PREFIXES: ["api", "login"] }));
vi.mock("../../../src/lib/static-export/site-enabled.js", () => ({
  isCurrentSiteStaticExportEnabled: async () => true,
}));
vi.mock("../../../src/lib/static-export/export-fetch.js", () => ({ exportFetch: mocks.fetch }));
vi.mock("../../../src/lib/static-export/index.js", () => ({
  resolveCrawlOrigin: async () => "http://127.0.0.1:3000",
  exportPageTools: async () => ({
    excluded: (path: string) => path === "/shop" || path.startsWith("/shop/"),
    pageBody: (page: { body: Buffer }) => page.body,
    cacheControlFor: () => "public, max-age=60, s-maxage=300",
  }),
}));
vi.mock("../../../src/lib/static-export/on-demand-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/static-export/on-demand-store.js")>();
  return {
    ...actual,
    get dbOnDemandStore() {
      return mocks.memory.store;
    },
  };
});
vi.mock("../../../src/lib/static-export/on-demand-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/static-export/on-demand-files.js")>();
  return { ...actual, onDemandFiles: () => mocks.files.api };
});
vi.mock("../../../src/lib/storage/storage-quota.js", () => ({ enforceStorageGrowth: async () => undefined }));
vi.mock("../../../src/lib/cdn/cdn-purge.js", () => ({ purgeCdnCache: mocks.purge }));
vi.mock("../../../src/lib/database/db.js", () => ({
  getDb: async () => ({ query: async () => [{ translation_group_id: "group-1" }] }),
}));

const { serveOnDemandStaticExport, noteOnDemandContentChange, noteOnDemandSiteChange, onDemandEngine } =
  await import("../../../src/lib/static-export/serve-on-demand.js");

/** A page the app renders, as `fetch` would return it. */
function appPage(body: string, init: { status?: number; deps?: string; cacheControl?: string; location?: string } = {}) {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": init.cacheControl ?? "public, max-age=60",
  });
  if (init.deps !== undefined) headers.set("x-justflows-export-deps", init.deps);
  if (init.location) headers.set("location", init.location);
  return new Response(init.status && init.status >= 300 && init.status < 400 ? null : body, {
    status: init.status ?? 200,
    headers,
  });
}

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  locals: Record<string, unknown> = {};
  headersSent = false;
  done = new Promise<void>((resolve) => this.on("finish", () => resolve()));
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  get text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const headers = init.headers ?? {};
  return {
    path,
    originalUrl: path,
    method: init.method ?? "GET",
    socket: { localPort: 3000 },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

/** Run the middleware. Resolves with "next" when the live app would answer. */
async function visit(path: string, init?: Parameters<typeof request>[1]) {
  const res = new FakeResponse();
  let calledNext = false;
  const next: NextFunction = () => {
    calledNext = true;
  };
  await serveOnDemandStaticExport(request(path, init), res as unknown as Response, next);
  if (calledNext) return { next: true as const, res };
  await res.done;
  return { next: false as const, res };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.memory = memoryStore();
  mocks.files = memoryFiles();
  mocks.cfg = {
    enabled: true,
    mode: "on-demand",
    ttlSeconds: 3600,
    renderCap: 2,
    siteRenderCap: 1,
    outDir: "/unused",
  };
  mocks.session.mockReturnValue(null);
  mocks.closed.mockResolvedValue(false);
  mocks.purge.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async () => appPage("<p>v1</p>", { deps: "c:post-1" }));
  await vi.waitFor(() => expect(onDemandEngine.running()).toBe(0));
});

describe("serveOnDemandStaticExport", () => {
  it("builds a page on its first visit and serves the file after that", async () => {
    const first = await visit("/about");
    expect(first.next).toBe(false);
    expect(first.res.text).toBe("<p>v1</p>");
    expect(first.res.headers["x-justflows-export"]).toBe("new");
    expect(first.res.headers["cache-control"]).toBe("public, max-age=60, s-maxage=300");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3000/about");
    expect((init as RequestInit).headers).toMatchObject({
      "x-jf-static-export": expect.stringMatching(/^on-demand\./),
    });

    const second = await visit("/about");
    expect(second.res.text).toBe("<p>v1</p>");
    expect(second.res.headers["x-justflows-export"]).toBe("fresh");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("serves a stale page to a burst of visitors at once and renders it once", async () => {
    await visit("/about");
    await noteOnDemandContentChange("published", { contentId: "post-1", siteId: SITE });
    /** A render starting in the same millisecond as the mark would count as stale too. */
    await tick();

    let finish!: () => void;
    mocks.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(appPage("<p>v2</p>", { deps: "c:post-1" }));
        }),
    );
    const burst = await Promise.all(Array.from({ length: 8 }, () => visit("/about")));
    /** Every visitor got the old file without waiting for the render. */
    expect(burst.every((r) => !r.next && r.res.text === "<p>v1</p>")).toBe(true);
    expect(burst.every((r) => r.res.headers["x-justflows-export"] === "stale")).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    finish();
    await vi.waitFor(() => expect(onDemandEngine.running()).toBe(0));
    const after = await visit("/about");
    expect(after.res.text).toBe("<p>v2</p>");
    expect(after.res.headers["x-justflows-export"]).toBe("fresh");
  });

  it("renders nothing when content or the menu changes, only on the next visit", async () => {
    await visit("/about");
    mocks.fetch.mockClear();
    await noteOnDemandContentChange("published", { contentId: "post-1", siteId: SITE });
    await noteOnDemandSiteChange(SITE);
    expect(mocks.fetch).not.toHaveBeenCalled();
    const next = await visit("/about");
    expect(next.res.headers["x-justflows-export"]).toBe("stale");
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  });

  it("lets the live app answer while the render caps are full", async () => {
    let finish!: () => void;
    mocks.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(appPage("<p>a</p>", { deps: "c:a" }));
        }),
    );
    const slow = visit("/a");
    await vi.waitFor(() => expect(onDemandEngine.running(SITE)).toBe(1));
    /** A crawler asking for another missing page is not queued behind the cap. */
    const crawler = await visit("/b");
    expect(crawler.next).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    finish();
    expect((await slow).res.text).toBe("<p>a</p>");
  });

  it("answers 404 from the live app straight after an unpublish", async () => {
    await visit("/about");
    await noteOnDemandContentChange("unpublished", { contentId: "post-1", siteId: SITE });
    expect(await mocks.memory.store.get(SITE, "/about")).toBeNull();
    expect(mocks.files.files.size).toBe(0);
    expect(mocks.purge).toHaveBeenCalledWith({ siteId: SITE });

    mocks.fetch.mockImplementation(async () => appPage("not found", { status: 404 }));
    const after = await visit("/about");
    expect(after.next).toBe(true);
    expect(mocks.files.files.size).toBe(0);
  });

  it("leaves redirects and private pages to the live app", async () => {
    mocks.fetch.mockImplementationOnce(async () => appPage("", { status: 301, location: "/new" }));
    expect((await visit("/old")).next).toBe(true);
    mocks.fetch.mockImplementationOnce(async () => appPage("<p>hi</p>", { cacheControl: "private, no-store" }));
    expect((await visit("/members")).next).toBe(true);
    expect(await mocks.memory.store.all(SITE)).toEqual([]);
  });

  it("only handles anonymous GETs of public pages in on-demand mode", async () => {
    expect((await visit("/about", { method: "POST" })).next).toBe(true);
    expect((await visit("/about?x=1")).next).toBe(true);
    expect((await visit("/about/")).next).toBe(true);
    expect((await visit("/shop/cart")).next).toBe(true);
    expect((await visit("/secret-admin/pages")).next).toBe(true);
    expect((await visit("/api/v1/content")).next).toBe(true);
    expect((await visit("/uploads/a.png")).next).toBe(true);
    expect((await visit("/about", { headers: { "x-jf-static-export": "1" } })).next).toBe(true);
    mocks.session.mockReturnValue({ userId: "u" });
    expect((await visit("/about")).next).toBe(true);
    mocks.session.mockReturnValue(null);
    mocks.closed.mockResolvedValue(true);
    expect((await visit("/about")).next).toBe(true);
    mocks.closed.mockResolvedValue(false);
    mocks.cfg = { ...mocks.cfg, mode: "full" };
    expect((await visit("/about")).next).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("falls back to the live app when the stored file is gone", async () => {
    await visit("/about");
    mocks.files.files.clear();
    const after = await visit("/about");
    expect(after.next).toBe(true);
    expect(await mocks.memory.store.get(SITE, "/about")).toBeNull();
  });
});
