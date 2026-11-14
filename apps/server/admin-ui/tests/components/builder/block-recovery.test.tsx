import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import { replacementBlock } from "../../../src/components/builder/BlockRecoveryPanel";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";
import { batchPreview } from "../../helpers/preview-batch";

/**
 * Blocks the builder cannot edit normally (justflows-ce#306): their extension
 * is off, they are deprecated, their upgrade failed, or drawing them throws.
 * None of these may change the stored block unless the author chooses to.
 */

const PARAGRAPH: BlockCatalogEntry = { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false, schema: { text: { type: "richtext" } } } as BlockCatalogEntry;
const SECTION: BlockCatalogEntry = { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true };
const OLD_CARD = {
  type: "acme.old",
  version: 2,
  title: "Old card",
  category: "content",
  supportsChildren: false,
  deprecated: { since: "2.0.0", replacedBy: "acme.card" },
  schema: { title: { type: "text" } },
} as BlockCatalogEntry;
const CARD = { type: "acme.card", version: 1, title: "Card", category: "content", supportsChildren: false, schema: { title: { type: "text" }, price: { type: "text" } } } as BlockCatalogEntry;

/** A block whose plugin is switched off: kept with its id, version, props and children. */
const gone: BlockNode = {
  id: "g1",
  type: "acme.gone",
  version: 3,
  props: { title: "Kept", price: "€5", nested: { a: [1, 2] } },
  children: [{ id: "g1-c", type: "core.paragraph", version: 1, props: { text: "Inside" } }],
};

let catalog: BlockCatalogEntry[] = [];

/** Makes the canvas renderer for a callout titled "boom" throw, like a bug in one block's preview would. */
let drawFails = false;
vi.mock("../../../src/components/builder/FunctionalBlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/components/builder/FunctionalBlock")>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      if (drawFails && props.type === "core.callout" && props.props.title === "boom") throw new Error("boom");
      return actual.default(props);
    },
  };
});
let previewReply: (body: Record<string, unknown>) => Response = () => json({ html: "<p>Card</p>" });
let catalogRequests = 0;

function json(data: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => data } as Response;
}

function mockFetch() {
  catalogRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/blocks/preview")) {
        return batchPreview(init, (body) => {
          if (!catalog.some((entry) => entry.type === body.type)) return json({ error: "Unknown block type" }, 404);
          return previewReply(body);
        });
      }
      if (url.includes("/api/blocks")) {
        catalogRequests++;
        return Promise.resolve(json({ blocks: catalog }));
      }
      if (url.includes("/api/auth/me")) return Promise.resolve(json({ id: "u1", email: "a@example.test", role: "admin", capabilities: ["content:update", "plugins:activate"] }));
      return Promise.resolve(json({}));
    }),
  );
}

let latest: BlockDocument;
function Controlled({ initial }: { initial: BlockDocument }) {
  const [value, setValue] = useState(initial);
  return (
    <PageBuilder
      value={value}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}

async function open(blocks: BlockNode[]) {
  latest = { version: 1, blocks };
  mockFetch();
  render(
    <SessionProvider>
      <I18nProvider>
        <Controlled initial={{ version: 1, blocks }} />
      </I18nProvider>
    </SessionProvider>,
  );
  await act(async () => {});
}

const select = (id: string) => fireEvent.click(document.querySelector(`[data-block-id="${id}"]`)!);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a block whose extension is off", () => {
  it("shows what is stored, and editing the page around it leaves it untouched", async () => {
    catalog = [PARAGRAPH, SECTION];
    await open([gone, { id: "p1", type: "core.paragraph", version: 1, props: { text: "Hello" } }]);
    expect(await screen.findByText("Unavailable block: acme.gone")).toBeInTheDocument();
    select("g1");
    expect(await screen.findByRole("heading", { name: "This block’s plugin or theme is not active" })).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("3 settings, 1 block inside")).toBeInTheDocument();

    /** Remove the other block: the unavailable one stays byte for byte. */
    select("p1");
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(latest.blocks).toHaveLength(1));
    expect(latest.blocks[0]).toEqual(gone);
  });

  it("comes back with Try again once the extension is active", async () => {
    catalog = [PARAGRAPH, SECTION];
    await open([gone]);
    select("g1");
    await screen.findByRole("heading", { name: "This block’s plugin or theme is not active" });
    catalog = [PARAGRAPH, SECTION, { ...CARD, type: "acme.gone", version: 3 }];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "This block’s plugin or theme is not active" })).not.toBeInTheDocument());
    expect(catalogRequests).toBe(2);
    expect(latest.blocks[0]).toEqual(gone);
  });

  it("copies its data, and is replaced or removed only after confirming", async () => {
    catalog = [PARAGRAPH, SECTION, CARD];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await open([gone]);
    select("g1");
    fireEvent.click(await screen.findByRole("button", { name: "Copy data" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(gone, null, 2)));

    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "acme.card" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(confirm.mock.calls[0]![0]).toMatch(/1 stored setting that the new block does not have/);
    expect(confirm.mock.calls[0]![0]).toMatch(/1 block inside it will be removed/);
    expect(latest.blocks[0]).toEqual(gone);

    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(latest.blocks[0]).toMatchObject({ id: "g1", type: "acme.card", props: { title: "Kept", price: "€5" } }));
    expect(latest.blocks[0]!.children).toBeUndefined();
  });

  it("is removed with its children only after confirming", async () => {
    catalog = [PARAGRAPH, SECTION];
    await open([gone]);
    select("g1");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const panel = (await screen.findByRole("heading", { name: "This block’s plugin or theme is not active" })).closest("section")!;
    fireEvent.click(within(panel).getByRole("button", { name: "Remove block" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("the 1 block inside it"));
    await waitFor(() => expect(latest.blocks).toEqual([]));
  });
});

describe("deprecated blocks and failed upgrades", () => {
  it("label a deprecated block, keep its settings, and offer its replacement", async () => {
    catalog = [PARAGRAPH, SECTION, OLD_CARD, CARD];
    await open([{ id: "o1", type: "acme.old", version: 2, props: { title: "Legacy" } }]);
    expect(await screen.findByText("This block is deprecated. Use acme.card for new content.")).toBeInTheDocument();
    select("o1");
    expect(await screen.findByRole("heading", { name: "This block is deprecated" })).toBeInTheDocument();
    expect(screen.getByLabelText("Replace with")).toHaveValue("acme.card");
  });

  it("say when a stored version could not be upgraded", async () => {
    catalog = [PARAGRAPH, SECTION, CARD];
    previewReply = () => json({ html: "<p>Stored</p>", migrationFailed: true });
    await open([{ id: "c1", type: "acme.card", version: 1, props: { title: "x" } }]);
    expect(await screen.findByText("This block could not be upgraded from version 1, so it shows its stored settings.")).toBeInTheDocument();
    expect(screen.getByText("Stored")).toBeInTheDocument();
    previewReply = () => json({ html: "<p>Card</p>" });
  });
});

describe("a block that fails to draw", () => {
  it("only breaks itself, can be tried again, and the document is not changed", async () => {
    catalog = [PARAGRAPH, SECTION, { type: "core.callout", version: 1, title: "Callout", category: "content", supportsChildren: true }];
    vi.spyOn(console, "error").mockImplementation(() => {});
    drawFails = true;
    const broken: BlockNode = { id: "c1", type: "core.callout", version: 1, props: { title: "boom" }, children: [] };
    const blocks = [broken, { id: "p1", type: "core.paragraph", version: 1, props: { text: "Still here" } }];
    await open(blocks);
    expect(await screen.findByText("Still here")).toBeInTheDocument();
    const notice = document.querySelector('[data-jf-block-failed="core.callout"]') as HTMLElement;
    expect(notice).toHaveTextContent("core.callout could not be shown in the builder.");
    expect(latest.blocks).toEqual(blocks);

    drawFails = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(document.querySelector('[data-jf-block-failed]')).toBeNull());
    expect(document.querySelector(".jf-callout")).not.toBeNull();
  });
});

describe("replacement", () => {
  it("keeps the id, carries matching settings, and keeps children when the target holds them", () => {
    const next = replacementBlock({ ...gone, editor: { label: "Pricing" } }, { ...CARD, supportsChildren: true } as BlockCatalogEntry);
    expect(next).toMatchObject({ id: "g1", type: "acme.card", props: { title: "Kept", price: "€5" }, children: gone.children, editor: { label: "Pricing" } });
    expect(next.props).not.toHaveProperty("nested");
  });
});
