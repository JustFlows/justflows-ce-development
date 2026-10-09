// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "../../../src/adapters/local-adapter.js";
import { S3StorageAdapter } from "../../../src/adapters/s3-adapter.js";

/** In-memory S3 that understands the handful of calls the adapter makes. */
function fakeS3(pageSize = 1000) {
  const objects = new Map<string, Buffer>();
  const calls: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
  const keyOf = (url: URL) => decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    calls.push({ method, url, headers });
    if (!headers["authorization"]?.startsWith("AWS4-HMAC-SHA256 "))
      return new Response("", { status: 403 });
    const key = keyOf(url);
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + pageSize);
      const more = start + pageSize < all.length;
      const xml =
        `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("")}` +
        `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (method === "PUT" && headers["x-amz-copy-source"]) {
      const from = decodeURIComponent(headers["x-amz-copy-source"].replace(/^\/bucket\//, ""));
      const body = objects.get(from);
      if (!body) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 200 });
      objects.set(key, body);
      return new Response("<CopyObjectResult/>", { status: 200 });
    }
    if (method === "PUT") {
      objects.set(key, Buffer.from(init!.body as Uint8Array));
      return new Response("", { status: 200 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const body = objects.get(key);
    if (!body) return new Response("", { status: 404 });
    if (method === "HEAD") return new Response(null, { status: 200 });
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
  return { objects, calls, fetchImpl };
}

function adapter(s3: ReturnType<typeof fakeS3>) {
  return new S3StorageAdapter({
    bucket: "bucket",
    region: "auto",
    endpoint: "https://s3.example.com",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    fetch: s3.fetchImpl,
  });
}

describe("S3StorageAdapter", () => {
  it("signs and sends optional object Cache-Control metadata", async () => {
    const s3 = fakeS3();
    await adapter(s3).save("index.html", Buffer.from("html"), "text/html", "public, max-age=60");
    const call = s3.calls[0]!;
    expect(call.headers["cache-control"]).toBe("public, max-age=60");
    expect(call.headers["authorization"]).toContain("cache-control");
  });

  it("uses path-style URLs with a custom endpoint and virtual-hosted on AWS", () => {
    const s3 = fakeS3();
    expect(adapter(s3).objectUrl("site/a b.png").toString()).toBe(
      "https://s3.example.com/bucket/site/a%20b.png",
    );
    const aws = new S3StorageAdapter({
      bucket: "media",
      region: "eu-west-1",
      accessKeyId: "A",
      secretAccessKey: "S",
    });
    expect(aws.objectUrl("site/x.png").toString()).toBe(
      "https://media.s3.eu-west-1.amazonaws.com/site/x.png",
    );
  });

  it("saves, reads, checks and deletes a signed object", async () => {
    const s3 = fakeS3();
    const store = adapter(s3);
    await store.save("site/x.png", Buffer.from("png"), "image/png");
    expect(s3.calls[0]?.headers["content-type"]).toBe("image/png");
    expect((await store.read("site/x.png"))?.body.toString()).toBe("png");
    expect(await store.exists("site/x.png")).toBe(true);
    await store.delete("site/x.png");
    expect(await store.read("site/x.png")).toBeNull();
    expect(await store.exists("site/x.png")).toBe(false);
  });

  it("moves a single object and reports a missing source", async () => {
    const s3 = fakeS3();
    const store = adapter(s3);
    await store.save("site/x.png", Buffer.from("png"), "image/png");
    expect(await store.move("site/x.png", "site/.trash/x.png")).toBe(true);
    expect([...s3.objects.keys()]).toEqual(["site/.trash/x.png"]);
    expect(await store.move("site/missing.png", "site/.trash/missing.png")).toBe(false);
  });

  it("lists across pages and moves a whole prefix", async () => {
    const s3 = fakeS3(2);
    const store = adapter(s3);
    for (const name of ["a", "b", "c"])
      await store.save(`site/m1/${name}.webp`, Buffer.from(name), "image/webp");
    await store.save("site/other.png", Buffer.from("o"), "image/png");
    expect(await store.list("site/m1/")).toEqual([
      "site/m1/a.webp",
      "site/m1/b.webp",
      "site/m1/c.webp",
    ]);
    expect(await store.move("site/m1/", "site/.trash/m1/")).toBe(true);
    expect(await store.list("site/m1/")).toEqual([]);
    expect(await store.list("site/.trash/m1/")).toHaveLength(3);
    await store.deletePrefix("site/.trash/");
    expect([...s3.objects.keys()]).toEqual(["site/other.png"]);
  });
});

describe("LocalStorageAdapter", () => {
  it("round-trips files and folders under its root, refusing escapes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jf-local-"));
    try {
      const store = new LocalStorageAdapter({ rootPath: root, baseUrl: "/uploads" });
      await store.save("site/m1/a.webp", Buffer.from("a"), "image/webp");
      expect(await store.list("site/")).toEqual(["site/m1/a.webp"]);
      expect(await store.move("site/m1/", "site/.trash/m1/")).toBe(true);
      expect((await store.read("site/.trash/m1/a.webp"))?.body.toString()).toBe("a");
      expect(await store.move("site/m1/", "site/x/")).toBe(false);
      await expect(store.read("../escape")).rejects.toThrow(/escapes/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
