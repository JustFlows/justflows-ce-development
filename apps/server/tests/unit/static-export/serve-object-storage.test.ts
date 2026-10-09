// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { serveStaticExportFromObjectStorage } from "../../../src/lib/static-export/serve-object-storage.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  open: vi.fn(),
  session: vi.fn(),
  enabled: vi.fn(),
}));
vi.mock("../../../src/lib/auth/session.js", () => ({ getSession: mocks.session }));
vi.mock("../../../src/lib/admin/admin-path.js", () => ({
  getAdminPathConfig: async () => ({ path: "/secret-admin" }),
}));
vi.mock("../../../src/lib/static-export/config.js", () => ({
  getStaticExportConfig: () => ({ enabled: true }),
  STATIC_EXPORT_HEADER: "x-jf-static-export",
}));
vi.mock("../../../src/lib/static-export/site-enabled.js", () => ({
  isCurrentSiteStaticExportEnabled: mocks.enabled,
}));
vi.mock("../../../src/lib/static-export/object-storage.js", () => ({
  staticExportDriver: () => "s3",
  staticExportObjectStore: () => ({ adapter: { open: mocks.open }, prefix: "site-a/" }),
  readDeployedEntries: mocks.read,
  deployedObjectKey: (prefix: string) => `${prefix}objects/hash/index.html`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockReturnValue(null);
  mocks.enabled.mockResolvedValue(true);
  mocks.read.mockResolvedValue([
    {
      path: "/about",
      file: "about/index.html",
      contentType: "text/html",
      cacheControl: "public, max-age=60",
    },
  ]);
  mocks.open.mockResolvedValue({
    status: 200,
    body: null,
    headers: new Headers({ etag: '"hash"' }),
  });
});
function request(path = "/about/", method = "HEAD", headers: Record<string, string> = {}) {
  return { path, originalUrl: path, method, get: (key: string) => headers[key] } as Request;
}
function response() {
  const res = {
    status: vi.fn(),
    setHeader: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    headersSent: false,
  };
  res.status.mockReturnValue(res);
  return res;
}
describe("private object storage origin gateway", () => {
  it("resolves directory routes and relays conditional headers and cache metadata", async () => {
    const res = response();
    const next = vi.fn();
    await serveStaticExportFromObjectStorage(
      request("/about/", "HEAD", { "if-none-match": '"hash"' }),
      res as unknown as Response,
      next,
    );
    expect(mocks.open).toHaveBeenCalledWith("site-a/objects/hash/index.html", {
      "if-none-match": '"hash"',
    });
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/html");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=60");
    expect(res.end).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
  it("keeps dynamic routes, queries, POST and export crawls on the live app", async () => {
    for (const req of [
      request("/api/test"),
      request("/secret-admin"),
      request("/admin"),
      request("/login"),
      request("/about?preview=1"),
      request("/about", "POST"),
      request("/about", "GET", { "x-jf-static-export": "1" }),
    ]) {
      const next = vi.fn();
      await serveStaticExportFromObjectStorage(req, response() as unknown as Response, next);
      expect(next).toHaveBeenCalled();
    }
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("bypasses authenticated visits and sites that disabled export", async () => {
    mocks.session.mockReturnValue({ userId: "u" });
    const next = vi.fn();
    await serveStaticExportFromObjectStorage(request(), response() as unknown as Response, next);
    mocks.session.mockReturnValue(null);
    mocks.enabled.mockResolvedValue(false);
    await serveStaticExportFromObjectStorage(request(), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("falls back to live rendering for missing routes, missing objects and storage failures", async () => {
    const next = vi.fn();
    await serveStaticExportFromObjectStorage(
      request("/removed"),
      response() as unknown as Response,
      next,
    );
    const cancel = vi.fn();
    mocks.open.mockResolvedValue({ status: 404, body: { cancel }, headers: new Headers() });
    await serveStaticExportFromObjectStorage(request(), response() as unknown as Response, next);
    expect(cancel).toHaveBeenCalled();
    mocks.read.mockRejectedValue(new Error("private bucket error"));
    await serveStaticExportFromObjectStorage(request(), response() as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
