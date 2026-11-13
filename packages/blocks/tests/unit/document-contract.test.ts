import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BlockPatternSchema } from "@justflows/sdk";
import {
  BlockMigrator,
  canNestBlock,
  coreBlocks,
  reassignBlockIds,
  repairBlockIds,
  sanitizeBlockDocument,
  sanitizeEditorMeta,
  validateBlockDocument,
  type BlockNestingLookup,
} from "../../src/index.js";
import { allFixtureDocuments, patternDefinition, pluginDocument } from "../fixtures/builder-documents.js";

const coreLookup: BlockNestingLookup = (type) => coreBlocks.find((block) => block.type === type);

/** Deep copy through JSON, which is exactly how stored documents travel. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function counter(prefix = "n"): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function ids(blocks: unknown[]): string[] {
  const out: string[] = [];
  const walk = (list: unknown[]) => {
    for (const node of list as Array<{ id: string; children?: unknown[] }>) {
      out.push(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(blocks);
  return out;
}

const themeTemplatesDir = fileURLToPath(new URL("../../../../themes/default/templates/", import.meta.url));

describe("canonical document round-trip", () => {
  for (const [kind, doc] of Object.entries(allFixtureDocuments)) {
    it(`keeps a ${kind} document unchanged, ids and all`, () => {
      const once = sanitizeBlockDocument(clone(doc));
      expect(JSON.parse(JSON.stringify(once))).toEqual(doc);
      expect(ids(once.blocks)).toEqual(ids(doc.blocks));
    });

    it(`sanitizes a ${kind} document idempotently`, () => {
      const once = sanitizeBlockDocument(clone(doc));
      const twice = sanitizeBlockDocument(clone(once));
      expect(twice).toEqual(once);
    });
  }

  it("round-trips every shipped default-theme template", () => {
    const files = readdirSync(themeTemplatesDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(themeTemplatesDir, file), "utf8")) as { blocks: unknown[] };
      const doc = { version: 1 as const, blocks: raw.blocks };
      const once = sanitizeBlockDocument(clone(doc));
      expect(ids(once.blocks), file).toEqual(ids(doc.blocks));
      expect(sanitizeBlockDocument(clone(once)), file).toEqual(once);
    }
  });

  it("still parses the pattern fixture with the SDK pattern schema", () => {
    expect(BlockPatternSchema.safeParse(patternDefinition).success).toBe(true);
  });

  it("drops transient editor state that is not part of the node contract", () => {
    const doc = sanitizeBlockDocument({
      version: 1,
      blocks: [
        {
          id: "a",
          type: "core.paragraph",
          version: 1,
          props: { text: "Hi" },
          selected: true,
          __dragging: { x: 1 },
          html: "<script>x()</script>",
        },
      ],
    });
    expect(Object.keys(doc.blocks[0] as object).sort()).toEqual(["children", "id", "props", "type", "version"]);
  });
});

describe("editor metadata", () => {
  it("keeps a plain-text label and true lock flags only", () => {
    expect(
      sanitizeEditorMeta({
        label: "  Hero <img src=x onerror=alert(1)>\n band ",
        lock: { move: true, remove: false, edit: "yes", other: true },
        selected: true,
      }),
    ).toEqual({ label: "Hero img src=x onerror=alert(1) band", lock: { move: true } });
  });

  it("drops an empty editor object instead of storing it", () => {
    const doc = sanitizeBlockDocument({
      version: 1,
      blocks: [{ id: "a", type: "core.paragraph", version: 1, props: {}, editor: { label: "  ", lock: {} } }],
    });
    expect(doc.blocks[0]).not.toHaveProperty("editor");
  });

  it("stores editor metadata beside props, never inside them", () => {
    const doc = sanitizeBlockDocument({
      version: 1,
      blocks: [{ id: "a", type: "core.paragraph", version: 1, props: {}, editor: { label: "Intro" } }],
    });
    expect(doc.blocks[0]).toMatchObject({ editor: { label: "Intro" }, props: {} });
  });

  it("caps the label length", () => {
    expect(sanitizeEditorMeta({ label: "x".repeat(500) })?.label).toHaveLength(80);
  });
});

describe("nesting rules", () => {
  it("only lets columns sit in a columns block", () => {
    expect(canNestBlock("core.columns", "core.column", coreLookup)).toBe(true);
    expect(canNestBlock(null, "core.column", coreLookup)).toBe(false);
    expect(canNestBlock("core.section", "core.column", coreLookup)).toBe(false);
    expect(canNestBlock("core.columns", "core.paragraph", coreLookup)).toBe(false);
  });

  it("rejects children for leaf blocks and unknown parents", () => {
    expect(canNestBlock("core.paragraph", "core.heading", coreLookup)).toBe(false);
    expect(canNestBlock("acme.missing", "core.heading", coreLookup)).toBe(false);
  });

  it("does not nest columns directly inside a column", () => {
    expect(canNestBlock("core.column", "core.columns", coreLookup)).toBe(false);
    expect(canNestBlock("core.column", "core.paragraph", coreLookup)).toBe(true);
  });

  it("honours a declared allowedChildTypes list", () => {
    const lookup: BlockNestingLookup = (type) =>
      type === "acme.tabs" ? { supportsChildren: true, allowedChildTypes: ["acme.tab"] } : undefined;
    expect(canNestBlock("acme.tabs", "acme.tab", lookup)).toBe(true);
    expect(canNestBlock("acme.tabs", "core.paragraph", lookup)).toBe(false);
  });
});

describe("validateBlockDocument", () => {
  it("finds no structural issues in any fixture", () => {
    for (const [kind, doc] of Object.entries(allFixtureDocuments)) {
      expect(validateBlockDocument(doc.blocks), kind).toEqual([]);
    }
  });

  it("reports nesting and unknown types against the core catalog, in document order", () => {
    const issues = validateBlockDocument(
      [
        { id: "a", type: "core.paragraph", version: 1, props: {}, children: [{ id: "b", type: "core.heading", version: 1, props: {} }] },
        { id: "c", type: "core.column", version: 1, props: {} },
        { id: "d", type: "acme.unknown", version: 1, props: {} },
      ],
      { lookup: coreLookup },
    );
    expect(issues).toEqual([
      { code: "invalid-parent", id: "b", type: "core.heading", path: [0, 0] },
      { code: "invalid-parent", id: "c", type: "core.column", path: [1] },
      { code: "unknown-type", id: "d", type: "acme.unknown", path: [2] },
    ]);
  });

  it("reports missing, invalid, and duplicate ids", () => {
    const issues = validateBlockDocument([
      { type: "core.paragraph", props: {} },
      { id: "has space", type: "core.paragraph", props: {} },
      { id: "dup", type: "core.paragraph", props: {} },
      { id: "dup", type: "core.paragraph", props: {} },
    ]);
    expect(issues.map((issue) => issue.code)).toEqual(["missing-id", "invalid-id", "duplicate-id"]);
    expect(issues[2]?.path).toEqual([3]);
  });

  it("detects a cycle in an in-memory tree instead of recursing forever", () => {
    const node: Record<string, unknown> = { id: "a", type: "core.group", version: 1, props: {} };
    node["children"] = [node];
    expect(validateBlockDocument([node]).map((issue) => issue.code)).toContain("cycle");
  });

  it("stops at the depth limit", () => {
    let deep: Record<string, unknown> = { id: "leaf", type: "core.group", props: {} };
    for (let i = 0; i < 40; i++) deep = { id: `g${i}`, type: "core.group", props: {}, children: [deep] };
    const issues = validateBlockDocument([deep], { maxDepth: 10 });
    expect(issues).toEqual([{ code: "max-depth", path: Array(10).fill(0) }]);
  });

  it("flags non-object nodes", () => {
    expect(validateBlockDocument(["text", null]).map((issue) => issue.code)).toEqual(["invalid-node", "invalid-node"]);
  });
});

describe("block ids", () => {
  it("gives every copied node a new id without touching the source", () => {
    const source = clone(allFixtureDocuments["page"]!.blocks);
    const copy = reassignBlockIds(source, counter("copy"));
    expect(ids(copy)).toEqual(ids(source).map((_, i) => `copy${i + 1}`));
    expect(source).toEqual(allFixtureDocuments["page"]!.blocks);
  });

  it("repairs only missing, invalid, and later duplicate ids", () => {
    const repaired = repairBlockIds(
      [
        { id: "keep", type: "a" },
        { type: "b" },
        { id: "keep", type: "c", children: [{ id: "bad id", type: "d" }] },
      ],
      counter("new"),
    );
    expect(ids(repaired)).toEqual(["keep", "new1", "new2", "new3"]);
  });

  it("leaves a valid document's ids exactly as they are", () => {
    const blocks = allFixtureDocuments["page"]!.blocks;
    expect(ids(repairBlockIds(blocks, counter()))).toEqual(ids(blocks));
  });
});

describe("BlockMigrator", () => {
  function sliderMigrator(): BlockMigrator {
    const migrator = new BlockMigrator();
    migrator.register({
      type: "acme.slider",
      from: 1,
      to: 2,
      migrate: (props) => {
        const { autoplay, ...rest } = props;
        return { ...rest, playback: autoplay ? "auto" : "manual" };
      },
    });
    return migrator;
  }

  it("migrates a plugin block one step and keeps its id", () => {
    const input = clone(pluginDocument);
    const result = sliderMigrator().migrateDocument(input);
    expect(result.changed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.document.blocks[0]).toMatchObject({ id: "x1", version: 2, props: { playback: "auto" } });
    expect(result.document.blocks[0]?.["props"]).not.toHaveProperty("autoplay");
  });

  it("never mutates its input, so the original is the rollback copy", () => {
    const input = clone(pluginDocument);
    sliderMigrator().migrateDocument(input);
    expect(input).toEqual(pluginDocument);
  });

  it("returns the same object when nothing needs migrating", () => {
    for (const [kind, doc] of Object.entries(allFixtureDocuments)) {
      if (kind === "plugin") continue;
      const result = sliderMigrator().migrateDocument(doc);
      expect(result.changed, kind).toBe(false);
      expect(result.document, kind).toBe(doc);
    }
  });

  it("migrates nested nodes inside every document kind", () => {
    for (const [kind, doc] of Object.entries(allFixtureDocuments)) {
      const nested = {
        version: 1 as const,
        blocks: [{ id: "wrap", type: "core.group", version: 1, props: {}, children: [...clone(pluginDocument.blocks), ...doc.blocks] }],
      };
      const result = sliderMigrator().migrateDocument(nested);
      expect(result.changed, kind).toBe(true);
      expect((result.document.blocks[0] as unknown as { children: Array<{ version: number }> }).children[0]?.version, kind).toBe(2);
    }
  });

  it("keeps a node unchanged and reports it when its migration throws", () => {
    const migrator = new BlockMigrator();
    migrator.register({ type: "acme.slider", from: 1, to: 2, migrate: () => { throw new Error("boom"); } });
    const result = migrator.migrateDocument(clone(pluginDocument));
    expect(result.changed).toBe(false);
    expect(result.document.blocks[0]).toEqual(pluginDocument.blocks[0]);
    expect(result.failures).toEqual([
      { reason: "migration-threw", path: [0], id: "x1", type: "acme.slider", version: 1, message: "boom" },
    ]);
  });

  it("rejects a migration that returns something other than props", () => {
    const migrator = new BlockMigrator();
    migrator.register({ type: "acme.slider", from: 1, to: 2, migrate: () => null as never });
    const result = migrator.migrateDocument(clone(pluginDocument));
    expect(result.failures[0]?.reason).toBe("migration-invalid-result");
    expect(result.document.blocks[0]).toEqual(pluginDocument.blocks[0]);
  });

  it("keeps a node newer than any known migration (plugin downgrade)", () => {
    const doc = { version: 1 as const, blocks: [{ id: "x1", type: "acme.slider", version: 5, props: { a: 1 } }] };
    const result = sliderMigrator().migrateDocument(doc);
    expect(result.document).toBe(doc);
    expect(result.failures[0]?.reason).toBe("future-version");
  });

  it("reports a gap in the chain without partially migrating", () => {
    const migrator = sliderMigrator();
    const doc = { version: 1 as const, blocks: [{ id: "x1", type: "acme.slider", version: 1, props: { autoplay: true } }] };
    const result = migrator.migrateDocument(doc, new Map([["acme.slider", 3]]));
    expect(result.document).toBe(doc);
    expect(result.failures[0]?.reason).toBe("missing-step");
  });

  it("leaves unknown block types and unsupported document versions alone", () => {
    const unknown = { version: 1 as const, blocks: [{ id: "u", type: "other.block", version: 1, props: {} }] };
    expect(sliderMigrator().migrateDocument(unknown).document).toBe(unknown);
    const future = { version: 2, blocks: [] };
    const result = sliderMigrator().migrateDocument(future);
    expect(result.document).toBe(future);
    expect(result.failures[0]?.reason).toBe("unsupported-document-version");
  });

  it("refuses duplicate or version-skipping registrations", () => {
    const migrator = sliderMigrator();
    expect(() => migrator.register({ type: "acme.slider", from: 1, to: 2, migrate: (p) => ({ ...p }) })).toThrow(/already registered/);
    expect(() => migrator.register({ type: "acme.slider", from: 2, to: 4, migrate: (p) => ({ ...p }) })).toThrow(/N \+ 1/);
  });

  it("produces a document that still sanitizes and validates", () => {
    const result = sliderMigrator().migrateDocument(clone(pluginDocument));
    const stored = sanitizeBlockDocument(result.document);
    expect(stored).toEqual(result.document);
    expect(validateBlockDocument(stored.blocks)).toEqual([]);
  });
});
