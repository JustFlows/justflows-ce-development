// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOnDemandEngine,
  freshness,
  isListPage,
  type OnDemandEnv,
  type RenderedPage,
} from "../../../src/lib/static-export/on-demand.js";
import type { OnDemandPage } from "../../../src/lib/static-export/on-demand-store.js";
import { memoryFiles, memoryStore } from "./on-demand-memory.js";

const SITE = "site-a";

function html(body: string, deps: string[] = ["c:post-1"]): RenderedPage {
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: Buffer.from(body),
    redirectedTo: null,
    cacheControl: "public, max-age=60",
    deps,
  };
}

/** A render that waits until the test lets it finish. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let clock = 1_000_000;
let memory: ReturnType<typeof memoryStore>;
let files: ReturnType<typeof memoryFiles>;
let render: ReturnType<typeof vi.fn<(path: string) => Promise<RenderedPage>>>;
let limits: OnDemandEnv["limits"];

function engine() {
  return createOnDemandEngine(() => ({
    store: memory.store,
    files: files.api,
    limits,
    render,
    prepare: async (_path, page) => ({ body: page.body, cacheControl: page.cacheControl }),
    enforceGrowth: async () => undefined,
    now: () => clock,
    log: () => undefined,
  }));
}

beforeEach(() => {
  clock = 1_000_000;
  memory = memoryStore();
  files = memoryFiles();
  limits = { ttlMs: 60_000, renderCap: 2, siteRenderCap: 1, maxPages: 100 };
  render = vi.fn(async () => html("<p>v1</p>"));
});

describe("freshness", () => {
  const page: OnDemandPage = {
    siteId: SITE,
    path: "/a",
    file: "f",
    sha256: "x",
    contentType: "text/html",
    cacheControl: "",
    bytes: 1,
    exportVersion: 5,
    renderedAt: 1000,
    markedAt: 0,
    dynamicList: false,
  };

  it("is missing without a file and fresh right after a render", () => {
    expect(freshness(null, 5, 1000, 60_000)).toBe("missing");
    expect(freshness(page, 5, 1500, 60_000)).toBe("fresh");
  });

  it("is stale after a mark, a version bump, or the expiry", () => {
    expect(freshness({ ...page, markedAt: 2000 }, 5, 2500, 60_000)).toBe("stale");
    /** A mark in the same millisecond the render started may have been missed by it. */
    expect(freshness({ ...page, markedAt: 1000 }, 5, 1500, 60_000)).toBe("stale");
    expect(freshness(page, 6, 1500, 60_000)).toBe("stale");
    expect(freshness(page, 5, 61_000, 60_000)).toBe("stale");
  });
});

describe("isListPage", () => {
  it("treats pages without an entry, home pages and paginated pages as lists", () => {
    expect(isListPage("/category/news", html("<p>list</p>", []))).toBe(true);
    expect(isListPage("/sitemap.xml", { ...html("<urlset/>", []), contentType: "application/xml" })).toBe(true);
    expect(isListPage("/", html("<p>home</p>"))).toBe(true);
    expect(isListPage("/nl-NL", html("<p>home</p>"))).toBe(true);
    expect(isListPage("/blog-page", html('<a href="/blog-page/page/2">next</a>'))).toBe(true);
    expect(isListPage("/about", html("<p>about</p>"))).toBe(false);
  });
});

describe("on-demand engine", () => {
  it("builds a page on first visit and stores its file", async () => {
    const outcome = await engine().render(SITE, "/about");
    expect(outcome?.kind).toBe("stored");
    expect(render).toHaveBeenCalledWith("/about");
    const page = await memory.store.get(SITE, "/about");
    expect(page).toMatchObject({ path: "/about", renderedAt: clock, exportVersion: 0, dynamicList: false });
    expect(files.files.get(page!.file)?.toString()).toBe("<p>v1</p>");
  });

  it("renders a page once for a burst of concurrent requests", async () => {
    const gate = deferred<RenderedPage>();
    render.mockImplementation(() => gate.promise);
    const e = engine();
    const runs = Array.from({ length: 10 }, () => e.render(SITE, "/about"));
    expect(runs.every((run) => run === runs[0])).toBe(true);
    gate.resolve(html("<p>v1</p>"));
    const outcomes = await Promise.all(runs);
    expect(render).toHaveBeenCalledTimes(1);
    expect(outcomes.every((o) => o?.kind === "stored")).toBe(true);
  });

  it("keeps background renders within the per-site and per-process caps", async () => {
    const gate = deferred<RenderedPage>();
    render.mockImplementation(() => gate.promise);
    const e = engine();
    expect(e.render(SITE, "/a")).not.toBeNull();
    /** The site's one slot is taken: a crawler's next page waits. */
    expect(e.render(SITE, "/b")).toBeNull();
    expect(e.render("site-b", "/a")).not.toBeNull();
    /** Two renders in this process: a third site waits too. */
    expect(e.render("site-c", "/a")).toBeNull();
    expect(e.running()).toBe(2);
    gate.resolve(html("<p>v1</p>"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(e.running()).toBe(0);
    expect(e.render(SITE, "/b")).not.toBeNull();
  });

  it("frees the slot when a render throws", async () => {
    render.mockRejectedValueOnce(new Error("socket hang up"));
    const e = engine();
    expect(await e.render(SITE, "/a")).toEqual({ kind: "failed", reason: "socket hang up" });
    expect(e.running()).toBe(0);
  });

  it("marks a page and every list stale on publish without rendering", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    render.mockResolvedValueOnce(html("<p>list</p>", []));
    await e.render(SITE, "/category/news");
    render.mockResolvedValueOnce(html("<p>other</p>", ["c:post-2"]));
    await e.render(SITE, "/other");
    render.mockClear();

    clock += 10;
    await e.contentChanged(SITE, ["c:post-1"]);
    const state = async (path: string) =>
      freshness(await memory.store.get(SITE, path), 0, clock, limits.ttlMs);
    expect(await state("/about")).toBe("stale");
    expect(await state("/category/news")).toBe("stale");
    expect(await state("/other")).toBe("fresh");
    expect(render).not.toHaveBeenCalled();
  });

  it("marks translations stale through the translation group", async () => {
    const e = engine();
    render.mockResolvedValueOnce(html("<p>nl</p>", ["c:post-nl", "g:group-1"]));
    await e.render(SITE, "/nl-NL/over");
    clock += 10;
    await e.contentChanged(SITE, ["c:post-en", "g:group-1"]);
    expect(freshness(await memory.store.get(SITE, "/nl-NL/over"), 0, clock, limits.ttlMs)).toBe("stale");
  });

  it("keeps a page stale when a change lands while it renders", async () => {
    const gate = deferred<RenderedPage>();
    render.mockImplementation(() => gate.promise);
    const e = engine();
    await memory.store.put(
      {
        siteId: SITE,
        path: "/about",
        file: "old",
        sha256: "old",
        contentType: "text/html",
        cacheControl: "",
        bytes: 3,
        exportVersion: 0,
        renderedAt: clock - 100,
        markedAt: 0,
        dynamicList: false,
      },
      ["c:post-1"],
    );
    const run = e.render(SITE, "/about");
    await new Promise((r) => setTimeout(r, 0));
    clock += 5;
    await e.contentChanged(SITE, ["c:post-1"]);
    gate.resolve(html("<p>rendered before the edit</p>"));
    await run;
    expect(freshness(await memory.store.get(SITE, "/about"), 0, clock, limits.ttlMs)).toBe("stale");
  });

  it("bumps the version so every file is stale in one write", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    await e.siteChanged(SITE);
    const version = await memory.store.getVersion(SITE);
    expect(version).toBeGreaterThan(0);
    expect(freshness(await memory.store.get(SITE, "/about"), version, clock, limits.ttlMs)).toBe("stale");
    /** Two changes in one millisecond still give two versions. */
    await e.siteChanged(SITE);
    expect(await memory.store.getVersion(SITE)).toBe(version + 1);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("expires a file after the configured time", async () => {
    await engine().render(SITE, "/about");
    const page = await memory.store.get(SITE, "/about");
    expect(freshness(page, 0, clock + limits.ttlMs - 1, limits.ttlMs)).toBe("fresh");
    expect(freshness(page, 0, clock + limits.ttlMs, limits.ttlMs)).toBe("stale");
  });

  it("removes an unpublished entry's own file right away and marks lists stale", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    render.mockResolvedValueOnce(html("<p>list</p>", []));
    await e.render(SITE, "/category/news");
    const own = (await memory.store.get(SITE, "/about"))!;
    clock += 10;
    expect(await e.contentRemoved(SITE, ["c:post-1", "g:group-1"])).toBe(1);
    expect(await memory.store.get(SITE, "/about")).toBeNull();
    expect(files.files.has(own.file)).toBe(false);
    expect(freshness(await memory.store.get(SITE, "/category/news"), 0, clock, limits.ttlMs)).toBe("stale");
  });

  it("removes the file when the app now answers 404", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    const old = (await memory.store.get(SITE, "/about"))!;
    render.mockResolvedValueOnce({ ...html("", []), status: 404 });
    expect(await e.render(SITE, "/about")).toEqual({ kind: "gone" });
    expect(await memory.store.get(SITE, "/about")).toBeNull();
    expect(files.files.has(old.file)).toBe(false);
  });

  it("does not store redirects or private pages", async () => {
    const e = engine();
    render.mockResolvedValueOnce({ ...html("", []), status: 301, redirectedTo: "/new" });
    expect(await e.render(SITE, "/old")).toEqual({ kind: "uncacheable" });
    render.mockResolvedValueOnce({ ...html("<p>hi</p>"), cacheControl: "private, no-store" });
    expect(await e.render(SITE, "/search")).toEqual({ kind: "uncacheable" });
    expect(await memory.store.all(SITE)).toEqual([]);
  });

  it("keeps the old file when the app fails", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    render.mockResolvedValueOnce({ ...html("", []), status: 503 });
    expect((await e.render(SITE, "/about"))?.kind).toBe("failed");
    expect(await memory.store.get(SITE, "/about")).not.toBeNull();
  });

  it("replaces the file on refresh and removes the old version", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    const old = (await memory.store.get(SITE, "/about"))!;
    clock += 10;
    render.mockResolvedValueOnce(html("<p>v2</p>"));
    e.refresh(SITE, "/about");
    await vi.waitFor(async () => expect((await memory.store.get(SITE, "/about"))?.file).not.toBe(old.file));
    const fresh = (await memory.store.get(SITE, "/about"))!;
    expect(files.files.get(fresh.file)?.toString()).toBe("<p>v2</p>");
    expect(files.files.has(old.file)).toBe(false);
  });

  it("skips a refresh another process has claimed", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    render.mockClear();
    expect(await memory.store.claim(SITE, "/about", clock, 60_000)).toBe(true);
    expect(await e.render(SITE, "/about", { claim: true })).toEqual({ kind: "skipped" });
    expect(render).not.toHaveBeenCalled();
  });

  it("does not store a page when the storage quota refuses it", async () => {
    const e = createOnDemandEngine(() => ({
      store: memory.store,
      files: files.api,
      limits,
      render,
      prepare: async (_path, page) => ({ body: page.body, cacheControl: page.cacheControl }),
      enforceGrowth: async () => {
        throw new Error("Storage limit reached");
      },
      now: () => clock,
      log: () => undefined,
    }));
    expect(await e.render(SITE, "/about")).toEqual({ kind: "failed", reason: "Storage limit reached" });
    expect(files.files.size).toBe(0);
  });

  it("stops building new pages at the site's page limit, per site", async () => {
    limits = { ...limits, maxPages: 1 };
    const e = engine();
    expect((await e.render(SITE, "/a"))?.kind).toBe("stored");
    expect(await e.render(SITE, "/b")).toEqual({ kind: "limit" });
    /** Another site has its own budget. */
    expect((await e.render("site-b", "/b"))?.kind).toBe("stored");
    /** A page that already has a file still refreshes. */
    clock += 10;
    render.mockResolvedValueOnce(html("<p>v2</p>"));
    expect((await e.render(SITE, "/a"))?.kind).toBe("stored");
  });

  it("marks only an entry's own page for a comment, and only lists for an id-less change", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    render.mockResolvedValueOnce(html("<p>list</p>", []));
    await e.render(SITE, "/category/news");
    const state = async (path: string) => freshness(await memory.store.get(SITE, path), 0, clock, limits.ttlMs);

    clock += 10;
    await e.pagesChanged(SITE, ["c:post-1"]);
    expect(await state("/about")).toBe("stale");
    expect(await state("/category/news")).toBe("fresh");

    clock += 10;
    render.mockResolvedValueOnce(html("<p>v2</p>"));
    await e.render(SITE, "/about");
    clock += 10;
    await e.listsChanged(SITE);
    expect(await state("/about")).toBe("fresh");
    expect(await state("/category/news")).toBe("stale");
  });

  it("leaves lists alone when a draft without a file is saved", async () => {
    const e = engine();
    render.mockResolvedValueOnce(html("<p>list</p>", []));
    await e.render(SITE, "/category/news");
    clock += 10;
    expect(await e.contentRemoved(SITE, ["c:draft-1"], { lists: "if-removed" })).toBe(0);
    expect(freshness(await memory.store.get(SITE, "/category/news"), 0, clock, limits.ttlMs)).toBe("fresh");
  });

  it("keeps sites apart: a change on one site never marks another", async () => {
    const e = engine();
    await e.render(SITE, "/about");
    await e.render("site-b", "/about");
    clock += 10;
    await e.contentChanged(SITE, ["c:post-1"]);
    await e.siteChanged(SITE);
    expect(freshness(await memory.store.get("site-b", "/about"), await memory.store.getVersion("site-b"), clock, limits.ttlMs)).toBe("fresh");
  });
});
