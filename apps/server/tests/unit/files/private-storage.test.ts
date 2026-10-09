// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import { localPrivateBackend, objectKey, parseByteRange, privateLocalRoot } from "../../../src/lib/files/private-storage.js";
import { contentDisposition } from "../../../src/lib/files/private-file-response.js";
import { isPrivateUploadPath } from "../../../src/lib/media/upload-serve.js";

const SITE = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jf-private-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.PRIVATE_STORAGE_PATH;
  delete process.env.STORAGE_LOCAL_PATH;
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("private file keys", () => {
  it("keeps every file in its site and owner folder", () => {
    expect(objectKey(SITE, "justflows.shop", "downloads/p1/manual.pdf")).toBe(`${SITE}/justflows.shop/downloads/p1/manual.pdf`);
    expect(() => objectKey(SITE, "justflows.shop", "../other/secret")).toThrow(/Invalid file key/);
    expect(() => objectKey(SITE, "justflows.shop", "/etc/passwd")).toThrow(/Invalid file key/);
    expect(() => objectKey(SITE, "justflows.shop", "folder/")).toThrow(/Invalid file key/);
    expect(() => objectKey(SITE, "Bad Owner", "a.txt")).toThrow(/Invalid file owner/);
  });
});

describe("byte ranges", () => {
  it("reads start-end, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=500-5000", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("ignores ranges it cannot serve", () => {
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange("bytes=2000-", 1000)).toBeNull();
    expect(parseByteRange("bytes=5-1", 1000)).toBeNull();
    expect(parseByteRange("items=0-1", 1000)).toBeNull();
  });
});

describe("local private storage", () => {
  it("stores, reads, and streams part of a file", async () => {
    const root = await tempRoot();
    const backend = localPrivateBackend(root);
    const key = objectKey(SITE, "justflows.shop", "downloads/p1/book.txt");
    await backend.put(key, Buffer.from("0123456789"), "text/plain");
    expect((await backend.read(key))?.toString()).toBe("0123456789");
    const whole = await backend.open(key);
    expect(whole).toMatchObject({ status: 200, size: 10 });
    expect(await text(whole!.body)).toBe("0123456789");
    const part = await backend.open(key, "bytes=2-4");
    expect(part).toMatchObject({ status: 206, size: 10, contentRange: "bytes 2-4/10" });
    expect(await text(part!.body)).toBe("234");
    await backend.delete(key);
    expect(await backend.open(key)).toBeNull();
  });

  it("never leaves its folder", async () => {
    const backend = localPrivateBackend(await tempRoot());
    await expect(backend.put("../escape.txt", Buffer.from("x"), "text/plain")).rejects.toThrow(/Unsafe/);
  });

  it("refuses a private folder inside the public uploads", async () => {
    const root = await tempRoot();
    process.env.STORAGE_LOCAL_PATH = path.join(root, "uploads");
    process.env.PRIVATE_STORAGE_PATH = path.join(root, "uploads", "private");
    expect(() => privateLocalRoot()).toThrow(/inside the public uploads/);
    process.env.PRIVATE_STORAGE_PATH = path.join(root, "private");
    expect(privateLocalRoot()).toBe(path.join(root, "private"));
  });
});

describe("serving private files", () => {
  it("never serves the private folder of the uploads bucket", () => {
    expect(isPrivateUploadPath("/.private/site/justflows.shop/a.pdf")).toBe(true);
    expect(isPrivateUploadPath("/%2Eprivate/site/a.pdf")).toBe(true);
    expect(isPrivateUploadPath("/.PRIVATE/a.pdf")).toBe(true);
    expect(isPrivateUploadPath("/static-export/sites/root/_deployment.json")).toBe(true);
    expect(isPrivateUploadPath("/%73tatic-export/sites/root/objects/a/index.html")).toBe(true);
    expect(isPrivateUploadPath(`/${SITE}/photo.jpg`)).toBe(false);
  });

  it("names the download safely", () => {
    expect(contentDisposition("attachment", "Handleiding één.pdf")).toBe(
      `attachment; filename="Handleiding __n.pdf"; filename*=UTF-8''Handleiding%20%C3%A9%C3%A9n.pdf`,
    );
    expect(contentDisposition("inline", 'a"\r\nb/../c.pdf')).toBe(`inline; filename="ab..c.pdf"; filename*=UTF-8''ab..c.pdf`);
  });
});
