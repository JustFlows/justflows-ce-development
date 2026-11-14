import { describe, expect, it } from "vitest";
import {
  BLOCK_DOCUMENT_MAX_DEPTH,
  BLOCK_DOCUMENT_MAX_NODES,
  createBlockRegistrySync,
  measureBlockDocument,
  sanitizeBlockDocument,
  withinBlockDocumentLimits,
} from "../../src/index.js";

/**
 * Hostile block documents fail safely (justflows-ce#309): a document nested
 * thousands of levels deep or holding a huge number of blocks used to fit in
 * a 2 MB request and overflow the stack in the sanitizer and the renderer.
 */

function nested(depth: number) {
  let node: Record<string, unknown> = { id: "leaf", type: "core.paragraph", version: 1, props: { text: "deepest" } };
  for (let i = 0; i < depth; i++) node = { id: `g${i}`, type: "core.group", version: 1, props: {}, children: [node] };
  return { version: 1, blocks: [node] };
}

function depthOf(blocks: unknown[]): number {
  let max = 0;
  const stack: Array<[unknown[], number]> = [[blocks, 1]];
  while (stack.length) {
    const [list, level] = stack.pop()!;
    for (const item of list) {
      max = Math.max(max, level);
      const kids = (item as { children?: unknown[] }).children;
      if (kids?.length) stack.push([kids, level + 1]);
    }
  }
  return max;
}

describe("block document limits", () => {
  it("measures depth and size without recursion, even for a 10,000-level document", () => {
    expect(measureBlockDocument(nested(10))).toEqual({ depth: 11, nodes: 11 });
    expect(withinBlockDocumentLimits(nested(10))).toBe(true);
    expect(withinBlockDocumentLimits(nested(10_000))).toBe(false);
    const wide = Array.from({ length: BLOCK_DOCUMENT_MAX_NODES + 1 }, (_, i) => ({ id: `p${i}`, type: "core.paragraph", props: {} }));
    expect(withinBlockDocumentLimits({ blocks: wide })).toBe(false);
  });

  it("sanitizes a hostile document without overflowing, cut off at the ceiling", () => {
    const clean = sanitizeBlockDocument(nested(10_000));
    expect(depthOf(clean.blocks)).toBe(BLOCK_DOCUMENT_MAX_DEPTH);
    const wide = Array.from({ length: BLOCK_DOCUMENT_MAX_NODES + 50 }, (_, i) => ({ id: `p${i}`, type: "core.paragraph", version: 1, props: {} }));
    expect(sanitizeBlockDocument({ blocks: wide }).blocks).toHaveLength(BLOCK_DOCUMENT_MAX_NODES);
  });

  it("keeps ordinary documents exactly as they are", () => {
    const doc = nested(20);
    expect(sanitizeBlockDocument(doc)).toEqual(sanitizeBlockDocument(JSON.parse(JSON.stringify(doc))));
    expect(depthOf(sanitizeBlockDocument(doc).blocks)).toBe(21);
  });

  it("renders a hostile document without overflowing the stack", () => {
    const html = createBlockRegistrySync().renderDocument(nested(10_000) as never);
    expect(html.startsWith("<div")).toBe(true);
    expect(html).not.toContain("deepest");
  });
});
