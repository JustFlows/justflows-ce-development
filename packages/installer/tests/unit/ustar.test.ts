// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveSafetyError } from "../../src/archive-safety.js";
import { extractJfpkg } from "../../src/extract-jfpkg.js";
import { extractTarGz, openNoFollow, parseUstar, UstarError, type UstarLimits } from "../../src/ustar.mjs";

const limits: UstarLimits = {
  maxExpandedBytes: 1024 * 1024,
  maxFileCount: 20,
  maxDecompressionRatio: 200,
  maxParseMs: 5_000,
};

const dirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-ustar-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function putOctal(block: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  block.write(digits, offset, length - 1, "utf8");
}

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name);
  putOctal(block, 100, 8, 0o644);
  putOctal(block, 108, 8, 0);
  putOctal(block, 116, 8, 0);
  putOctal(block, 124, 12, size);
  putOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  block.write("ustar", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += block[i] ?? 0;
  block.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function archive(files: { name: string; data?: string; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.data ?? "");
    parts.push(header(file.name, file.type === "5" ? 0 : data.length, file.type ?? "0"));
    if (data.length > 0 && file.type !== "5") {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe("parseUstar", () => {
  it("reads a regular file", () => {
    const entries = parseUstar(archive([{ name: "justflows.json", data: "{\"ok\":true}" }]), limits);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("justflows.json");
    expect(entries[0]?.data.toString("utf8")).toBe("{\"ok\":true}");
  });

  it("rejects a bad checksum, a base-256 size, a symlink, a duplicate, and a parent path", () => {
    const badSum = archive([{ name: "a.txt", data: "hi" }]);
    badSum[0] = 0x41;
    expect(() => parseUstar(badSum, limits)).toThrow(UstarError);

    const encoded = header("a.txt", 1, "0");
    encoded[124] = 0x80;
    let sum = 0;
    encoded.fill(0x20, 148, 156);
    for (let i = 0; i < 512; i += 1) sum += encoded[i] ?? 0;
    encoded.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
    encoded[154] = 0;
    encoded[155] = 0x20;
    const body = Buffer.alloc(512);
    body[0] = 0x61;
    expect(() => parseUstar(Buffer.concat([encoded, body, Buffer.alloc(1024)]), limits)).toThrow(/numeric encoding/);

    expect(() => parseUstar(archive([{ name: "link", data: "target", type: "2" }]), limits)).toThrow(/Unsupported/);
    expect(() => parseUstar(archive([
      { name: "a.txt", data: "one" },
      { name: "a.txt", data: "two" },
    ]), limits)).toThrow(/Conflicting/);
    expect(() => parseUstar(archive([{ name: "../outside.txt", data: "nope" }]), limits)).toThrow(/traversal/);
  });

  it("rejects a truncated archive and stops when the time limit has already passed", () => {
    expect(() => parseUstar(Buffer.from([1, 2, 3]), limits)).toThrow(/Truncated/);
    const whole = archive([{ name: "a.txt", data: "hi" }]);
    expect(() => parseUstar(whole.subarray(0, 600), limits)).toThrow(/Truncated/);
    expect(() => parseUstar(whole, { ...limits, maxParseMs: 0 }, Date.now() - 50)).toThrow(/timed out/);
  });
});

describe("extractTarGz", () => {
  it("writes a valid archive and writes nothing when parsing fails", async () => {
    const dest = tmp();
    await extractTarGz(gzipSync(archive([{ name: "nested/hello.txt", data: "ok" }])), dest, limits);
    expect(fs.readFileSync(path.join(dest, "nested", "hello.txt"), "utf8")).toBe("ok");

    const rejected = tmp();
    const bad = archive([{ name: "a.txt", data: "hi" }]);
    bad[0] = 0x41;
    await expect(extractTarGz(gzipSync(bad), rejected, limits)).rejects.toThrow(UstarError);
    expect(fs.readdirSync(rejected)).toEqual([]);
  });

  it("extracts through the worker and reports a safety error from the parent", async () => {
    const dest = tmp();
    const payload = randomBytes(400).toString("base64");
    await extractJfpkg(gzipSync(archive([{ name: "justflows.json", data: payload }])), dest);
    expect(fs.readFileSync(path.join(dest, "justflows.json"), "utf8")).toBe(payload);

    const rejected = tmp();
    const bad = archive([{ name: "../x", data: "nope" }]);
    await expect(extractJfpkg(gzipSync(bad), rejected)).rejects.toBeInstanceOf(ArchiveSafetyError);
    expect(fs.readdirSync(rejected)).toEqual([]);
  });

  it("does not follow a symlink left in the destination", async () => {
    const dest = tmp();
    const outside = tmp();
    fs.symlinkSync(path.join(outside, "pwned.txt"), path.join(dest, "justflows.json"));
    const payload = randomBytes(80).toString("base64");
    await expect(
      extractTarGz(gzipSync(archive([{ name: "justflows.json", data: payload }])), dest, limits),
    ).rejects.toThrow(UstarError);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });
});

describe("openNoFollow without O_NOFOLLOW", () => {
  it("opens a file and a directory, and refuses a link or a file opened as a directory", async () => {
    const dir = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(dir, "a.txt"), "ok");
    fs.writeFileSync(path.join(outside, "secret.txt"), "no");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    fs.symlinkSync(outside, path.join(dir, "linkdir"));

    const file = await openNoFollow(path.join(dir, "a.txt"), fs.constants.O_RDONLY, { native: false });
    expect((await file.readFile()).toString()).toBe("ok");
    await file.close();
    const folder = await openNoFollow(dir, fs.constants.O_RDONLY, { native: false, directory: true });
    await folder.close();

    await expect(
      openNoFollow(path.join(dir, "link.txt"), fs.constants.O_RDONLY, { native: false }),
    ).rejects.toMatchObject({ code: "ELOOP" });
    await expect(
      openNoFollow(path.join(dir, "linkdir"), fs.constants.O_RDONLY, { native: false, directory: true }),
    ).rejects.toMatchObject({ code: "ELOOP" });
    await expect(
      openNoFollow(path.join(dir, "a.txt"), fs.constants.O_RDONLY, { native: false, directory: true }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
