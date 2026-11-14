import { useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import { BuilderDragProvider, useBuilderDrag, useBuilderRowDrag } from "../../../src/components/builder/DragContext";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/**
 * Performance budgets for long documents (justflows-ce#308).
 *
 * The budgets are counts, which are the same on every machine: how many block
 * previews redraw for one edit or one selection change, and how many requests
 * previews and reusable blocks cost as a page grows. Times are only checked
 * loosely, to catch large regressions; docs/BUILDER-PERFORMANCE.md records them.
 */

const renders = new Map<string, number>();
vi.mock("../../../src/components/builder/BlockPreview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/components/builder/BlockPreview")>();
  return {
    ...actual,
    BlockPreview: (props: Parameters<typeof actual.BlockPreview>[0]) => {
      renders.set(props.block.id, (renders.get(props.block.id) ?? 0) + 1);
      return actual.BlockPreview(props);
    },
  };
});
const { default: PageBuilder } = await import("../../../src/components/builder/PageBuilder");

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true },
  { type: "core.heading", version: 1, title: "Heading", category: "content", supportsChildren: false },
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
  { type: "core.button", version: 1, title: "Button", category: "content", supportsChildren: false },
  { type: "core.reusable", version: 1, title: "Reusable block", category: "layout", supportsChildren: false },
  { type: "acme.card", version: 1, title: "Card", category: "content", supportsChildren: false },
];

/** Representative documents: sections of a heading, two paragraphs and a button. */
export const SIZES = { small: 20, medium: 200, large: 1000 } as const;

function document_(total: number, extra: (s: number) => BlockNode[] = () => []): BlockDocument {
  const blocks: BlockNode[] = [];
  for (let s = 0; s < total / 5; s++) {
    blocks.push({
      id: `s${s}`,
      type: "core.section",
      version: 1,
      props: {},
      children: [
        { id: `h${s}`, type: "core.heading", version: 1, props: { level: 2, text: `Heading ${s}` } },
        { id: `p${s}a`, type: "core.paragraph", version: 1, props: { text: `Paragraph ${s}` } },
        { id: `p${s}b`, type: "core.paragraph", version: 1, props: { text: `More ${s}` } },
        { id: `b${s}`, type: "core.button", version: 1, props: { label: "Go", url: "/x" } },
        ...extra(s),
      ],
    });
  }
  return { version: 1, blocks };
}

const requests: string[] = [];
let batchSizes: number[] = [];

function mockFetch() {
  requests.length = 0;
  batchSizes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
      if (url.includes("/api/blocks/preview/batch")) {
        const { items } = JSON.parse(String(init?.body)) as { items: unknown[] };
        batchSizes.push(items.length);
        return ok({ results: items.map(() => ({ status: 200, body: { html: "<p>Card</p>" } })) });
      }
      if (url.includes("/api/blocks")) return ok({ blocks: CATALOG });
      if (url.includes("/api/reusable-blocks")) return ok({ items: [{ id: "cta", name: "CTA", revision: 1, updatedAt: "", blocks: [{ id: "x", type: "core.paragraph", version: 1, props: { text: "Shared" } }] }] });
      if (url.includes("/api/auth/me")) return ok({ id: "u1", email: "a@example.test", role: "editor", capabilities: ["content:update"] });
      return ok({});
    }),
  );
}

let setDocument: (doc: BlockDocument) => void = () => {};
function Host({ initial }: { initial: BlockDocument }) {
  const [value, setValue] = useState(initial);
  setDocument = setValue;
  return <PageBuilder value={value} onChange={setValue} />;
}

async function open(doc: BlockDocument) {
  mockFetch();
  renders.clear();
  const started = performance.now();
  const view = render(
    <SessionProvider>
      <I18nProvider>
        <Host initial={doc} />
      </I18nProvider>
    </SessionProvider>,
  );
  await act(async () => {});
  await act(async () => {});
  return { view, mountMs: performance.now() - started };
}

const previewRenders = () => [...renders.values()].reduce((a, b) => a + b, 0);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(Object.entries(SIZES))("%s document", (_name, total) => {
  it("redraws only the edited block and its parent for one edit", async () => {
    const doc = document_(total);
    const { view } = await open(doc);
    expect(renders.size).toBe(total);
    renders.clear();
    const edited = { ...doc, blocks: doc.blocks.map((b, i) => (i === 0 ? { ...b, children: b.children!.map((c, j) => (j === 1 ? { ...c, props: { text: "Typed" } } : c)) } : b)) };
    const started = performance.now();
    await act(async () => setDocument(edited));
    const editMs = performance.now() - started;
    expect(previewRenders()).toBeLessThanOrEqual(2);
    expect([...renders.keys()].sort()).toEqual(["p0a", "s0"]);
    expect(editMs).toBeLessThan(250);
    view.unmount();
  });

  it("redraws only the blocks the selection enters and leaves", async () => {
    const { view } = await open(document_(total));
    renders.clear();
    await act(async () => (document.querySelector('[data-block-id="p1a"] .jf-canvas-block__name') as HTMLElement).click());
    expect(previewRenders()).toBeLessThanOrEqual(2);
    renders.clear();
    await act(async () => (document.querySelector('[data-block-id="p2a"] .jf-canvas-block__name') as HTMLElement).click());
    /** Leaving p1a (and its section) and entering p2a (and its section). */
    expect(previewRenders()).toBeLessThanOrEqual(4);
    view.unmount();
  });
});

describe("previews and shared data as pages grow", () => {
  it("asks for plugin previews in batches, and only again for the block that changed", async () => {
    const card = (s: number): BlockNode[] => [0, 1, 2].map((i) => ({ id: `c${s}-${i}`, type: "acme.card", version: 1, props: { n: s * 3 + i } }));
    const doc = document_(200, card);
    const { view } = await open(doc);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    /** 120 plugin blocks, at most 50 per request. */
    expect(batchSizes).toEqual([50, 50, 20]);
    const edited = { ...doc, blocks: doc.blocks.map((b, i) => (i === 0 ? { ...b, children: b.children!.map((c) => (c.id === "c0-0" ? { ...c, props: { n: 999 } } : c)) } : b)) };
    await act(async () => setDocument(edited));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(batchSizes).toEqual([50, 50, 20, 1]);
    view.unmount();
  });

  it("loads the reusable block library once, however many references a page has", async () => {
    const ref = (s: number): BlockNode[] => [{ id: `r${s}`, type: "core.reusable", version: 1, props: { ref: "cta" } }];
    const { view } = await open(document_(250, ref));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(requests.filter((url) => url.includes("/api/reusable-blocks")).length).toBeLessThanOrEqual(1);
    view.unmount();
  });
});

describe("dragging", () => {
  it("does not redraw canvas rows while the drop target moves", async () => {
    let rowRenders = 0;
    let aim: ((index: number) => void) | null = null;
    function Row() {
      useBuilderRowDrag();
      rowRenders++;
      return null;
    }
    function Pointer() {
      const { setDropTarget } = useBuilderDrag();
      aim = (index) => setDropTarget({ parentId: null, parentType: null, index });
      return null;
    }
    render(
      <I18nProvider>
        <BuilderDragProvider blocks={[]} catalog={new Map()} onChange={() => {}} onSelect={() => {}}>
          <Row />
          <Pointer />
        </BuilderDragProvider>
      </I18nProvider>,
    );
    const before = rowRenders;
    for (let i = 0; i < 10; i++) await act(async () => aim!(i));
    expect(rowRenders).toBe(before);
  });
});
