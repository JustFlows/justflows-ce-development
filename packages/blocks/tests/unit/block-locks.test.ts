// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { blockLockViolations, sanitizeBlockDocument } from "../../src/index.js";

const p = (id: string, text = id, editor?: Record<string, unknown>) => ({
  id,
  type: "core.paragraph",
  version: 1,
  props: { text },
  ...(editor ? { editor } : {}),
});
const group = (id: string, children: unknown[], editor?: Record<string, unknown>) => ({
  id,
  type: "core.group",
  version: 1,
  props: {},
  children,
  ...(editor ? { editor } : {}),
});

describe("blockLockViolations", () => {
  it("allows any change to unlocked blocks", () => {
    expect(blockLockViolations([p("a"), p("b")], [p("b", "changed")])).toEqual([]);
  });

  it("refuses removing a remove-locked block, also through its ancestor", () => {
    const before = [group("g", [p("a", "a", { lock: { remove: true } })]), p("b")];
    expect(blockLockViolations(before, [p("b")])).toEqual([{ id: "a", type: "core.paragraph", rule: "remove" }]);
  });

  it("refuses editing an edit-locked block but ignores key order", () => {
    const locked = { id: "a", type: "core.heading", version: 1, props: { text: "x", level: 2 }, editor: { lock: { edit: true } } };
    const reordered = { ...locked, props: { level: 2, text: "x" } };
    expect(blockLockViolations([locked], [reordered])).toEqual([]);
    expect(blockLockViolations([locked], [{ ...locked, props: { text: "y", level: 2 } }])).toEqual([
      { id: "a", type: "core.heading", rule: "edit" },
    ]);
  });

  it("allows edits to children of an edit-locked container", () => {
    const before = [group("g", [p("a")], { lock: { edit: true } })];
    const after = [group("g", [p("a", "new"), p("c")], { lock: { edit: true } })];
    expect(blockLockViolations(before, after)).toEqual([]);
  });

  it("refuses reparenting a move-locked block or swapping it with another locked sibling", () => {
    const lockedB = p("b", "b", { lock: { move: true } });
    const lockedC = p("c", "c", { lock: { move: true } });
    expect(blockLockViolations([p("a"), lockedB], [p("a"), group("g", [lockedB])])).toEqual([
      { id: "b", type: "core.paragraph", rule: "move" },
    ]);
    expect(blockLockViolations([lockedB, lockedC], [lockedC, lockedB]).map((v) => v.id)).toEqual(["b", "c"]);
  });

  it("allows inserting, removing, or reordering unlocked siblings around a move-locked block", () => {
    const lockedB = p("b", "b", { lock: { move: true } });
    const before = [p("a"), lockedB, p("c")];
    expect(blockLockViolations(before, [p("new"), lockedB, p("c")])).toEqual([]);
    expect(blockLockViolations(before, [lockedB, p("c"), p("a")])).toEqual([]);
  });

  it("allows deleting a block that is only move-locked", () => {
    expect(blockLockViolations([p("a", "a", { lock: { move: true } })], [])).toEqual([]);
  });

  it("refuses adding, changing, or removing locks on existing blocks", () => {
    expect(blockLockViolations([p("a")], [p("a", "a", { lock: { edit: true } })])).toEqual([
      { id: "a", type: "core.paragraph", rule: "lock" },
    ]);
    expect(blockLockViolations([p("a", "a", { lock: { edit: true } })], [p("a")])).toEqual([
      { id: "a", type: "core.paragraph", rule: "lock" },
    ]);
  });

  it("lets new blocks arrive with locks", () => {
    expect(blockLockViolations([], [p("a", "a", { lock: { remove: true } })])).toEqual([]);
  });

  it("compares the stored shape after sanitizing", () => {
    const before = sanitizeBlockDocument({ blocks: [p("a", "a", { lock: { edit: true, bogus: true } })] }).blocks;
    const after = sanitizeBlockDocument({ blocks: [p("a", "a", { lock: { edit: true } })] }).blocks;
    expect(blockLockViolations(before, after)).toEqual([]);
  });
});
