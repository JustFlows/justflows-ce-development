// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantRequestContext } from "../../../src/lib/tenancy/context.js";
import { sha256, type StaticExportManifest } from "../../../src/lib/static-export/manifest.js";
import {
  clearDeployedStaticExport,
  deployStaticExport,
  staticExportDriver,
  staticExportObjectPrefix,
} from "../../../src/lib/static-export/object-storage.js";
import { enforceStorageGrowth } from "../../../src/lib/storage/storage-quota.js";

vi.mock("../../../src/lib/storage/storage-quota.js", () => ({ enforceStorageGrowth: vi.fn() }));
vi.mock("../../../src/lib/tenancy/registry.js", () => ({ installationRootSiteId: async () => "root-site" }));
vi.mock("../../../src/lib/cdn/cdn-purge.js", () => ({ purgeCdnCache: vi.fn() }));
const objects = new Map<string, { body: Buffer; headers: Headers }>();
let folder: string;
let failPut = false;
const tenant = (siteId: string, hostname = "demo.example.com"): TenantRequestContext => ({
  siteId,
  hostname,
  tenantId: "t",
  userMode: "isolated",
  databaseMode: "current",
  activePluginIds: null,
});
function manifest(body = "<html>Hello</html>"): StaticExportManifest {
  return {
    generatedAt: new Date().toISOString(),
    mode: "full",
    justflowsVersion: "0.3.4",
    publicUrl: "https://demo.example.com",
    config: { maxPages: 2000, concurrency: 4 },
    assets: [],
    routes: [
      {
        path: "/",
        file: "index.html",
        status: 200,
        bytes: Buffer.byteLength(body),
        sha256: sha256(body),
        contentType: "text/html",
        cacheControl: "public, max-age=60",
        deps: { content: [], translationGroups: [], dynamicList: false },
      },
    ],
  };
}
beforeEach(async () => {
  objects.clear();
  failPut = false;
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "jf-export-"));
  for (const [key, value] of Object.entries({
    STORAGE_S3_BUCKET: "test-bucket",
    STORAGE_S3_ENDPOINT: "https://s3.example.com",
    STORAGE_S3_REGION: "gra",
    STORAGE_S3_ACCESS_KEY_ID: "test-key",
    STORAGE_S3_SECRET_ACCESS_KEY: "test-secret",
    STORAGE_S3_PREFIX: "install-a",
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(input);
      const key = decodeURIComponent(url.pathname).replace("/test-bucket/", "");
      const method = init?.method ?? "GET";
      if (url.searchParams.has("list-type")) {
        const prefix = url.searchParams.get("prefix")!;
        return new Response(
          `<ListBucketResult>${[...objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => `<Contents><Key>${k}</Key></Contents>`)
            .join("")}</ListBucketResult>`,
        );
      }
      if (method === "PUT") {
        if (failPut && key.includes("/objects/")) return new Response("", { status: 503 });
        objects.set(key, {
          body: Buffer.from(init!.body as Uint8Array),
          headers: new Headers(init?.headers),
        });
        return new Response("", { status: 200 });
      }
      if (method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const object = objects.get(key);
      return new Response(method === "HEAD" ? null : object ? new Uint8Array(object.body) : null, {
        status: object ? 200 : 404,
        headers: object?.headers,
      });
    }),
  );
  await fs.writeFile(path.join(folder, "index.html"), "<html>Hello</html>");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await fs.rm(folder, { recursive: true, force: true });
});

describe("static export object storage", () => {
  it("reads the deployment pointer once and reuses its size for quota growth", async () => {
    await deployStaticExport(folder, manifest());
    vi.mocked(fetch).mockClear();
    vi.mocked(enforceStorageGrowth).mockClear();
    await deployStaticExport(folder, manifest());
    const pointerReads = vi.mocked(fetch).mock.calls.filter(([input, init]) =>
      new URL(input as string).pathname.endsWith("/_deployment.json") && (init?.method ?? "GET") === "GET",
    );
    expect(pointerReads).toHaveLength(1);
    expect(enforceStorageGrowth).toHaveBeenCalledExactlyOnceWith("root-site", 0);
  });
  it("uses separate stable site prefixes and the same folder across domain changes", () => {
    expect(staticExportObjectPrefix()).toBe("install-a/static-export/sites/root/");
    expect(runWithTenant(tenant("site-a"), staticExportObjectPrefix)).toBe(
      "install-a/static-export/sites/site-a/",
    );
    expect(runWithTenant(tenant("site-a", "new.example.com"), staticExportObjectPrefix)).toBe(
      "install-a/static-export/sites/site-a/",
    );
    expect(runWithTenant(tenant("site-b"), staticExportObjectPrefix)).not.toBe(
      runWithTenant(tenant("site-a"), staticExportObjectPrefix),
    );
    vi.stubEnv("STORAGE_S3_PREFIX", "../uploads");
    expect(staticExportObjectPrefix).toThrow("Invalid static export storage prefix");
  });
  it("uploads content/cache headers, and publishes only manifest files", async () => {
    await fs.writeFile(path.join(folder, ".env"), "never upload");
    await deployStaticExport(folder, manifest());
    const stored = [...objects.entries()].find(([key]) => key.includes("/objects/"))!;
    expect(stored[1].headers.get("content-type")).toBe("text/html");
    expect(stored[1].headers.get("cache-control")).toBe("public, max-age=60");
    expect(objects.size).toBe(2);
    const pointer = objects.get("install-a/static-export/sites/root/_deployment.json")!;
    expect(JSON.parse(pointer.body.toString()).entries[0].path).toBe("/");
  });
  it("uploads only HTML and removes old exported images without touching original media", async () => {
    const value = manifest();
    value.assets.push({
      path: "/uploads/photo.jpg",
      file: "uploads/photo.jpg",
      contentType: "image/jpeg",
      cacheControl: "public, max-age=3600",
      sha256: sha256("image"),
      status: 200,
      bytes: 5,
    });
    value.routes.push({
      ...value.routes[0]!,
      path: "/sitemap.xml",
      file: "sitemap.xml",
      contentType: "application/xml",
    });
    const old = value.assets[0]!;
    const oldKey = `install-a/static-export/sites/root/objects/${old.sha256}/${old.file}`;
    objects.set(oldKey, { body: Buffer.from("image"), headers: new Headers() });
    objects.set("install-a/static-export/sites/root/_deployment.json", {
      body: Buffer.from(JSON.stringify({ version: 1, entries: [old] })),
      headers: new Headers(),
    });
    objects.set("install-a/uploads/photo.jpg", {
      body: Buffer.from("image"),
      headers: new Headers(),
    });
    await deployStaticExport(folder, value);
    expect(objects.has(oldKey)).toBe(false);
    expect(objects.has("install-a/uploads/photo.jpg")).toBe(true);
    const pointer = JSON.parse(
      objects.get("install-a/static-export/sites/root/_deployment.json")!.body.toString(),
    );
    expect(pointer.entries.map((entry: { file: string }) => entry.file)).toEqual(["index.html"]);
  });
  it("leaves the previous pointer intact on upload failure", async () => {
    await deployStaticExport(folder, manifest());
    const pointer = objects.get("install-a/static-export/sites/root/_deployment.json")!.body;
    await fs.writeFile(path.join(folder, "index.html"), "changed");
    failPut = true;
    await expect(deployStaticExport(folder, manifest("changed"))).rejects.toThrow();
    expect(objects.get("install-a/static-export/sites/root/_deployment.json")!.body).toEqual(
      pointer,
    );
  });
  it("rejects corrupt local files and traversal before publishing", async () => {
    await expect(deployStaticExport(folder, manifest("changed"))).rejects.toThrow(
      "changed during deployment",
    );
    const bad = manifest();
    bad.routes[0]!.file = "../.env";
    await expect(deployStaticExport(folder, bad)).rejects.toThrow();
    expect(objects.size).toBe(0);
  });
  it("removes unpublished routes from the pointer and clears only this site's objects", async () => {
    await runWithTenant(tenant("site-a"), () => deployStaticExport(folder, manifest()));
    await runWithTenant(tenant("site-b"), () => deployStaticExport(folder, manifest()));
    const empty = manifest();
    empty.routes = [];
    await runWithTenant(tenant("site-a"), () => deployStaticExport(folder, empty));
    expect(
      JSON.parse(
        objects.get("install-a/static-export/sites/site-a/_deployment.json")!.body.toString(),
      ).entries,
    ).toEqual([]);
    objects.set("install-a/uploads/logo.png", {
      body: Buffer.from("upload"),
      headers: new Headers(),
    });
    await runWithTenant(tenant("site-a"), clearDeployedStaticExport);
    expect([...objects.keys()].some((k) => k.includes("/site-a/"))).toBe(false);
    expect([...objects.keys()].some((k) => k.includes("/site-b/"))).toBe(true);
    expect(objects.has("install-a/uploads/logo.png")).toBe(true);
  });
  it("cleans interrupted uploads even without a pointer", async () => {
    objects.set("install-a/static-export/sites/root/objects/orphan/index.html", {
      body: Buffer.from("orphan"),
      headers: new Headers(),
    });
    expect(await clearDeployedStaticExport()).toBe(true);
    expect(objects.size).toBe(0);
  });
  it("defaults to local and refuses unknown drivers", () => {
    vi.stubEnv("STATIC_EXPORT_STORAGE_DRIVER", "");
    expect(staticExportDriver()).toBe("local");
    vi.stubEnv("STATIC_EXPORT_STORAGE_DRIVER", "swift");
    expect(staticExportDriver).toThrow();
  });
});
