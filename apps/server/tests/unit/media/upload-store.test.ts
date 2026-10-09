// SPDX-License-Identifier: MIT

import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveMediaStorage } from "../../../src/lib/content/trash.js";
import { uploadsHandler } from "../../../src/lib/media/upload-serve.js";
import {
  getUploadStore,
  isSafeUploadKey,
  s3UploadConfig,
} from "../../../src/lib/media/upload-store.js";

const quota = vi.hoisted(() => ({ enforce: vi.fn() }));
vi.mock("../../../src/lib/storage/storage-quota.js", () => ({ withSiteStorageLock: async (_site: string, work: () => Promise<unknown>) => work(), enforceStorageGrowth: quota.enforce }));

const SITE = "033fcfcc-8948-417d-928f-62f5b7954b67";
const saved = { ...process.env };
const realFetch = globalThis.fetch;

/** Minimal in-memory S3 (path-style, bucket "media"). */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const fake = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith("s3.test")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = decodeURIComponent(url.pathname.replace(/^\/media\/?/, ""));
    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      return new Response(
        `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    }
    if (method === "PUT" && headers["x-amz-copy-source"]) {
      const from = decodeURIComponent(headers["x-amz-copy-source"].replace(/^\/media\//, ""));
      const body = objects.get(from);
      if (!body) return new Response("<Error><Code>NoSuchKey</Code></Error>");
      objects.set(key, body);
      return new Response("<CopyObjectResult/>");
    }
    if (method === "PUT") {
      objects.set(key, Buffer.from(init!.body as Uint8Array));
      return new Response("");
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const body = objects.get(key);
    if (!body) return new Response("", { status: 404 });
    return new Response(method === "HEAD" ? null : new Uint8Array(body), {
      headers: { "content-type": "image/png", "content-length": String(body.length), etag: '"e1"' },
    });
  }) as typeof fetch;
  return { objects, fake };
}

let bucketSeq = 0;
beforeEach(() => {
  quota.enforce.mockReset().mockResolvedValue(undefined);
  process.env.STORAGE_DRIVER = "s3";
  // A fresh endpoint per test so the cached store picks up the stubbed fetch.
  process.env.STORAGE_S3_ENDPOINT = `https://t${++bucketSeq}.s3.test`;
  process.env.STORAGE_S3_BUCKET = "media";
  process.env.STORAGE_S3_ACCESS_KEY_ID = "AK";
  process.env.STORAGE_S3_SECRET_ACCESS_KEY = "SK";
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

describe("upload store config", () => {
  it("reads the legacy S3_* names from .env.example", () => {
    delete process.env.STORAGE_S3_BUCKET;
    delete process.env.STORAGE_S3_ACCESS_KEY_ID;
    process.env.S3_BUCKET = "legacy";
    process.env.S3_ACCESS_KEY_ID = "LK";
    const cfg = s3UploadConfig();
    expect(cfg.bucket).toBe("legacy");
    expect(cfg.accessKeyId).toBe("LK");
  });

  it("names every missing S3 setting", () => {
    delete process.env.STORAGE_S3_BUCKET;
    delete process.env.STORAGE_S3_SECRET_ACCESS_KEY;
    expect(() => getUploadStore()).toThrow(/STORAGE_S3_BUCKET, STORAGE_S3_SECRET_ACCESS_KEY/);
  });

  it("rejects unsafe keys", () => {
    for (const key of ["", "/a", "../a", "a/../b", "a//b", "a\\b", "a/./b"]) {
      expect(isSafeUploadKey(key)).toBe(false);
    }
    expect(isSafeUploadKey(`${SITE}/m1/`)).toBe(true);
    expect(isSafeUploadKey(`${SITE}/.trash/a.png`)).toBe(true);
  });
});

describe("S3 driver", () => {
  it("refuses a trash copy before writing when the storage allowance is exhausted", async () => {
    const s3 = fakeS3(); vi.stubGlobal("fetch", s3.fake);
    await getUploadStore().put(`${SITE}/a.png`, Buffer.from("png"), "image/png");
    quota.enforce.mockRejectedValue(new Error("Storage limit exceeded"));
    await expect(moveMediaStorage(`${SITE}/a.png`, true)).rejects.toThrow("Storage limit exceeded");
    expect([...s3.objects.keys()]).toEqual([`${SITE}/a.png`]);
    expect(quota.enforce).toHaveBeenCalledWith(SITE, 3);
  });

  it("trashes and restores media under the site's own prefix", async () => {
    const s3 = fakeS3();
    vi.stubGlobal("fetch", s3.fake);
    const store = getUploadStore();
    await store.put(`${SITE}/a.png`, Buffer.from("png"), "image/png");

    await moveMediaStorage(`${SITE}/a.png`, true);
    expect([...s3.objects.keys()]).toEqual([`${SITE}/.trash/a.png`]);
    await moveMediaStorage(`${SITE}/a.png`, false);
    expect([...s3.objects.keys()]).toEqual([`${SITE}/a.png`]);
  });

  it("prefixes keys when several installs share a bucket", async () => {
    const s3 = fakeS3();
    vi.stubGlobal("fetch", s3.fake);
    process.env.STORAGE_S3_PREFIX = "/install-1/";
    const store = getUploadStore();
    await store.put(`${SITE}/a.png`, Buffer.from("png"), "image/png");
    expect([...s3.objects.keys()]).toEqual([`install-1/${SITE}/a.png`]);
    expect(await store.list(`${SITE}/`)).toEqual([`${SITE}/a.png`]);
  });

  async function serve(path: string, headers: Record<string, string> = {}) {
    const app = express();
    app.use("/uploads", uploadsHandler(60_000));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      return await realFetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });
    } finally {
      server.close();
    }
  }

  it("proxies /uploads from the bucket and hides dot folders", async () => {
    const s3 = fakeS3();
    vi.stubGlobal("fetch", s3.fake);
    await getUploadStore().put(`${SITE}/a.png`, Buffer.from("png"), "image/png");
    await getUploadStore().put(`${SITE}/.trash/b.png`, Buffer.from("png"), "image/png");

    const ok = await serve(`/uploads/${SITE}/a.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await ok.text()).toBe("png");

    expect((await serve(`/uploads/${SITE}/.trash/b.png`)).status).toBe(404);
    expect((await serve(`/uploads/${SITE}/missing.png`)).status).toBe(404);
  });

  it("redirects to the public URL, but serves the static exporter inline", async () => {
    const s3 = fakeS3();
    vi.stubGlobal("fetch", s3.fake);
    process.env.STORAGE_S3_PUBLIC_URL = "https://cdn.example.com/";
    await getUploadStore().put(`${SITE}/a.png`, Buffer.from("png"), "image/png");

    const redirect = await serve(`/uploads/${SITE}/a.png`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`https://cdn.example.com/${SITE}/a.png`);

    const inline = await serve(`/uploads/${SITE}/a.png`, { "x-jf-static-export": "1" });
    expect(inline.status).toBe(200);
  });
});
