// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNoFollow, PACKAGE_DIGEST_LIMITS, walkTree } from "../../../src/lib/security/file-digest.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jf-digest-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("openNoFollow", () => {
  it("without O_NOFOLLOW opens a file and a directory, and refuses links and a file as a directory", async () => {
    const dir = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(dir, "a.txt"), "ok");
    fs.writeFileSync(path.join(outside, "secret.txt"), "no");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    fs.symlinkSync(outside, path.join(dir, "linkdir"));
    const read = fs.constants.O_RDONLY;

    const file = await openNoFollow(path.join(dir, "a.txt"), read, { native: false });
    expect((await file.readFile()).toString()).toBe("ok");
    await file.close();
    const folder = await openNoFollow(dir, read, { native: false, directory: true });
    await folder.close();

    await expect(openNoFollow(path.join(dir, "link.txt"), read, { native: false })).rejects.toMatchObject({
      code: "ELOOP",
    });
    await expect(
      openNoFollow(path.join(dir, "linkdir"), read, { native: false, directory: true }),
    ).rejects.toMatchObject({ code: "ELOOP" });
    await expect(
      openNoFollow(path.join(dir, "a.txt"), read, { native: false, directory: true }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("walkTree hashes files and reports links without reading them", async () => {
    const dir = tmp();
    const outside = tmp();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "a.txt"), "ok");
    fs.writeFileSync(path.join(outside, "secret.txt"), "no");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));

    const result = await walkTree(dir, PACKAGE_DIGEST_LIMITS);
    expect(result.files.map((file) => file.path)).toEqual(["sub/a.txt"]);
    expect(result.unexpected).toEqual(["link.txt"]);
  });
});
