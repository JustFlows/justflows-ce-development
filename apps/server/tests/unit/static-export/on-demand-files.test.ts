// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const s3 = vi.hoisted(() => ({
  save: vi.fn(),
  open: vi.fn(),
  delete: vi.fn(),
  deletePrefix: vi.fn(),
}));
vi.mock("../../../src/lib/static-export/object-storage.js", () => ({
  staticExportDriver: () => (process.env.STATIC_EXPORT_STORAGE_DRIVER === "s3" ? "s3" : "local"),
  staticExportObjectStore: () => ({ adapter: s3, prefix: "media/static-export/sites/root/" }),
}));

const {
  localOnDemandFiles,
  onDemandFileKey,
  onDemandFiles,
  s3OnDemandFiles,
  ON_DEMAND_DIR,
} = await import("../../../src/lib/static-export/on-demand-files.js");

const HASH = "a".repeat(64);
const SHA = "b".repeat(64);

async function readAll(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

describe("onDemandFileKey", () => {
  it("names a file by path hash and content hash, with an extension from the type", () => {
    expect(onDemandFileKey(HASH, SHA, "text/html; charset=utf-8")).toBe(`aa/${HASH}/${SHA}.html`);
    expect(onDemandFileKey(HASH, SHA, "application/xml")).toBe(`aa/${HASH}/${SHA}.xml`);
    expect(onDemandFileKey(HASH, SHA, "application/feed+json")).toBe(`aa/${HASH}/${SHA}.json`);
    expect(onDemandFileKey(HASH, SHA, "image/png")).toBe(`aa/${HASH}/${SHA}.bin`);
  });
});

describe("local on-demand files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "jf-on-demand-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes under the export directory, serves with an ETag and answers 304", async () => {
    const files = localOnDemandFiles(() => dir);
    const key = onDemandFileKey(HASH, SHA, "text/html");
    await files.save("site", key, Buffer.from("<p>hi</p>"), "text/html", "public");
    expect(await fs.readFile(path.join(dir, ON_DEMAND_DIR, key), "utf8")).toBe("<p>hi</p>");

    const opened = await files.open("site", key, {});
    expect(opened?.status).toBe(200);
    expect(opened?.etag).toBe(`"${SHA}"`);
    expect(await readAll(opened!.body)).toBe("<p>hi</p>");

    const cached = await files.open("site", key, { "if-none-match": `"${SHA}"` });
    expect(cached?.status).toBe(304);
    expect(cached?.body).toBeNull();
  });

  it("returns null for a missing file and removes files and the folder", async () => {
    const files = localOnDemandFiles(() => dir);
    const key = onDemandFileKey(HASH, SHA, "text/html");
    expect(await files.open("site", key, {})).toBeNull();
    await files.save("site", key, Buffer.from("x"), "text/html", "public");
    await files.remove("site", key);
    expect(await files.open("site", key, {})).toBeNull();
    await files.save("site", key, Buffer.from("x"), "text/html", "public");
    await files.clear("site");
    await expect(fs.stat(path.join(dir, ON_DEMAND_DIR))).rejects.toThrow();
  });

  it("refuses keys that are not on-demand file names", async () => {
    const files = localOnDemandFiles(() => dir);
    await expect(files.save("site", "../../etc/passwd", Buffer.from("x"), "text/html", "")).rejects.toThrow(
      /Unsafe/,
    );
    await expect(files.open("site", "index.html", {})).rejects.toThrow(/Unsafe/);
  });
});

describe("S3 on-demand files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores private objects under the site's export prefix", async () => {
    const files = s3OnDemandFiles();
    const key = onDemandFileKey(HASH, SHA, "text/html");
    await files.save("site", key, Buffer.from("<p>hi</p>"), "text/html", "public, max-age=60");
    expect(s3.save).toHaveBeenCalledWith(
      `media/static-export/sites/root/on-demand/${key}`,
      Buffer.from("<p>hi</p>"),
      "text/html",
      "public, max-age=60",
    );
    await files.remove("site", key);
    expect(s3.delete).toHaveBeenCalledWith(`media/static-export/sites/root/on-demand/${key}`);
    await files.clear("site");
    expect(s3.deletePrefix).toHaveBeenCalledWith("media/static-export/sites/root/on-demand/");
  });

  it("streams the object, passes conditional headers and maps a 404 to null", async () => {
    const files = s3OnDemandFiles();
    const key = onDemandFileKey(HASH, SHA, "text/html");
    s3.open.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ etag: '"e"' }),
      body: new Response("<p>hi</p>").body,
    });
    const opened = await files.open("site", key, { "if-none-match": '"x"' });
    expect(s3.open).toHaveBeenCalledWith(`media/static-export/sites/root/on-demand/${key}`, {
      "if-none-match": '"x"',
    });
    expect(opened?.etag).toBe('"e"');
    expect(await readAll(opened!.body)).toBe("<p>hi</p>");

    s3.open.mockResolvedValueOnce({ status: 404, headers: new Headers(), body: null });
    expect(await files.open("site", key, {})).toBeNull();
  });

  it("is chosen by the storage driver", () => {
    process.env.STATIC_EXPORT_STORAGE_DRIVER = "s3";
    try {
      const files = onDemandFiles(() => "/unused");
      expect(files.save).toBeTypeOf("function");
      void files.clear("site");
      expect(s3.deletePrefix).toHaveBeenCalled();
    } finally {
      delete process.env.STATIC_EXPORT_STORAGE_DRIVER;
    }
  });
});
