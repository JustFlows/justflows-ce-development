// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { crawlPages, linkToInternalPath, type FetchedResource } from "../../../src/lib/static-export/crawl.js";

function html(body: string): FetchedResource {
  return {
    path: "",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: Buffer.from(body, "utf8"),
    redirectedTo: null,
  };
}

function fakeSite(pages: Record<string, string>) {
  return async (path: string): Promise<FetchedResource> => {
    if (path in pages) return { ...html(pages[path]!), path };
    return {
      path,
      status: 404,
      contentType: "text/html",
      body: Buffer.from("nope"),
      redirectedTo: null,
    };
  };
}

describe("linkToInternalPath", () => {
  it("keeps same-origin absolute and relative links", () => {
    expect(linkToInternalPath("/about", "")).toBe("/about");
    expect(linkToInternalPath("https://ex.com/x", "https://ex.com")).toBe("/x");
  });
  it("drops external links, anchors and schemes", () => {
    expect(linkToInternalPath("https://other.com/x", "https://ex.com")).toBeNull();
    expect(linkToInternalPath("#top", "")).toBeNull();
    expect(linkToInternalPath("mailto:a@b.c", "")).toBeNull();
  });
});

describe("crawlPages", () => {
  it("follows internal links breadth-first and records assets", async () => {
    const site = fakeSite({
      "/": `<a href="/about">a</a><a href="/blog">b</a><link rel="stylesheet" href="/theme.css">`,
      "/about": `<a href="/">home</a><img src="/uploads/x.png">`,
      "/blog": `<a href="/blog/page/2">next</a>`,
      "/blog/page/2": `<p>page 2</p>`,
    });
    const out = await crawlPages(["/"], site, {
      maxPages: 50,
      concurrency: 3,
      publicUrl: "",
      discoverLinks: true,
    });
    const paths = out.pages.map((p) => p.path).sort();
    expect(paths).toEqual(["/", "/about", "/blog", "/blog/page/2"]);
    const homeAssets = out.pages.find((p) => p.path === "/")!.assetRefs;
    expect(homeAssets).toContain("/theme.css");
  });

  it("never fetches an excluded path, even when a page links to it", async () => {
    const fetched: string[] = [];
    const site = fakeSite({
      "/": `<a href="/shop">s</a><a href="/shop/cart">c</a><a href="/shop/cart/step">x</a>`,
      "/shop": `<p>shop</p>`,
      "/shop/cart": `<p>cart</p>`,
    });
    const out = await crawlPages(
      ["/", "/shop/cart"],
      async (path) => {
        fetched.push(path);
        return site(path);
      },
      {
        maxPages: 50,
        concurrency: 2,
        publicUrl: "",
        discoverLinks: true,
        exclude: (path) => path === "/shop/cart" || path.startsWith("/shop/cart/"),
      },
    );
    expect(out.pages.map((p) => p.path).sort()).toEqual(["/", "/shop"]);
    expect(fetched.some((path) => path.startsWith("/shop/cart"))).toBe(false);
  });

  it("crawls pages whose slug merely starts with a reserved prefix", async () => {
    const site = fakeSite({
      "/":
        `<a href="/extensions">x</a><a href="/registration">r</a>` +
        `<a href="/ext/acme.plugin/thing">skip</a><a href="/api/x">skip</a>`,
      "/extensions": `<p>real page</p>`,
      "/registration": `<p>real page</p>`,
    });
    const out = await crawlPages(["/"], site, {
      maxPages: 50,
      concurrency: 3,
      publicUrl: "",
      discoverLinks: true,
    });
    const paths = out.pages.map((p) => p.path).sort();
    expect(paths).toEqual(["/", "/extensions", "/registration"]);
  });

  it("does not discover links when discoverLinks is false", async () => {
    const site = fakeSite({ "/": `<a href="/about">a</a>`, "/about": `x` });
    const out = await crawlPages(["/"], site, {
      maxPages: 50,
      concurrency: 2,
      publicUrl: "",
      discoverLinks: false,
    });
    expect(out.pages.map((p) => p.path)).toEqual(["/"]);
  });

  it("stops at maxPages", async () => {
    const pages: Record<string, string> = { "/": "" };
    for (let i = 0; i < 20; i++) pages[`/p${i}`] = `<a href="/p${i + 1}">n</a>`;
    pages["/"] = `<a href="/p0">start</a>`;
    const out = await crawlPages(["/"], fakeSite(pages), {
      maxPages: 5,
      concurrency: 1,
      publicUrl: "",
      discoverLinks: true,
    });
    expect(out.hitLimit).toBe(true);
    expect(out.pages.length).toBeLessThanOrEqual(5);
  });

  it("captures redirects instead of bodies", async () => {
    const fetcher = async (path: string): Promise<FetchedResource> =>
      path === "/old"
        ? { path, status: 301, contentType: "", body: Buffer.alloc(0), redirectedTo: "/new" }
        : {
            path,
            status: 200,
            contentType: "text/html",
            body: Buffer.from("<p>new</p>"),
            redirectedTo: null,
          };
    const out = await crawlPages(["/old"], fetcher, {
      maxPages: 10,
      concurrency: 1,
      publicUrl: "",
      discoverLinks: true,
    });
    expect(out.redirects).toEqual([{ from: "/old", to: "/new" }]);
    expect(out.pages.map((p) => p.path)).toEqual(["/new"]);
  });
});


it("never fetches account pages even when seeded or linked", async () => {
  const fetched: string[] = [];
  const out = await crawlPages(["/", "/account", "/account/details"], async (path) => {
    fetched.push(path); return { ...html('<a href="/account">Account</a><a href="/account/orders">Orders</a>'), path };
  }, { maxPages: 20, concurrency: 1, publicUrl: "", discoverLinks: true });
  expect(fetched).toEqual(["/"]); expect(out.pages.map(page => page.path)).toEqual(["/"]);
});
