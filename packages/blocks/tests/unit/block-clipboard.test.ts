// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  BLOCK_CLIPBOARD_FORMAT,
  BLOCK_CLIPBOARD_MAX_NODES,
  looksLikeBlockClipboard,
  parseBlockClipboard,
  plainTextToBlocks,
  serializeBlockClipboard,
} from "../../src/index.js";

const counter = () => {
  let n = 0;
  return () => `n${++n}`;
};

describe("block clipboard", () => {
  it("round-trips blocks with fresh ids and no locks", () => {
    const text = serializeBlockClipboard([
      {
        id: "a",
        type: "core.group",
        version: 1,
        props: {},
        editor: { label: "Hero", lock: { remove: true } },
        children: [{ id: "b", type: "core.paragraph", version: 1, props: { text: "Hi" } }],
      },
    ]);
    expect(looksLikeBlockClipboard(text)).toBe(true);
    const parsed = parseBlockClipboard(text, counter());
    expect(parsed).toEqual({
      ok: true,
      blocks: [
        {
          id: "n1",
          type: "core.group",
          version: 1,
          props: {},
          editor: { label: "Hero" },
          children: [{ id: "n2", type: "core.paragraph", version: 1, props: { text: "Hi" } }],
        },
      ],
    });
  });

  it("sanitizes executable content on the way in", () => {
    const text = JSON.stringify({
      format: BLOCK_CLIPBOARD_FORMAT,
      version: 1,
      blocks: [
        { id: "a", type: "core.paragraph", props: { text: '<img src=x onerror="alert(1)">Hi<script>x</script>' } },
        { id: "b", type: "core.button", props: { label: "Go", url: "javascript:alert(1)" } },
        { id: "c", type: "core.html", props: { html: "<script>alert(1)</script><p>ok</p>" } },
      ],
    });
    const parsed = parseBlockClipboard(text, counter());
    expect(parsed.ok).toBe(true);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/onerror|<script|javascript:/i);
  });

  it("keeps a reusable reference as a reference", () => {
    const text = serializeBlockClipboard([{ id: "r", type: "core.reusable", version: 1, props: { ref: "shared-1" } }]);
    const parsed = parseBlockClipboard(text, counter());
    expect(parsed.ok && parsed.blocks[0]).toMatchObject({ type: "core.reusable", props: { ref: "shared-1" } });
  });

  it("rejects text that is not builder data, and oversized payloads", () => {
    expect(parseBlockClipboard("hello", counter())).toEqual({ ok: false, reason: "not-blocks" });
    expect(parseBlockClipboard('{"format":"other","blocks":[]}', counter())).toEqual({ ok: false, reason: "not-blocks" });
    const many = Array.from({ length: BLOCK_CLIPBOARD_MAX_NODES + 1 }, (_, i) => ({ id: `x${i}`, type: "core.paragraph", props: {} }));
    expect(parseBlockClipboard(serializeBlockClipboard(many), counter())).toEqual({ ok: false, reason: "too-large" });
    expect(parseBlockClipboard(serializeBlockClipboard([{ id: "x" }]), counter())).toEqual({ ok: false, reason: "empty" });
  });

  it("turns plain text into escaped paragraphs", () => {
    expect(plainTextToBlocks("One <b>\nline\n\nTwo", counter())).toEqual([
      { id: "n1", type: "core.paragraph", version: 1, props: { text: "One &lt;b&gt;<br>line" } },
      { id: "n2", type: "core.paragraph", version: 1, props: { text: "Two" } },
    ]);
  });
});
