import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import BlockLibrary from "../../../src/components/builder/BlockLibrary";
import { BuilderDragProvider } from "../../../src/components/builder/DragContext";
import { createBlock, setBlockCatalog } from "../../../src/components/builder/block-defaults";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/** The builder side of the plugin and theme block contract (justflows-ce#305). */

const PRICING: BlockCatalogEntry = {
  type: "acme.pricing",
  version: 2,
  title: "Pricing card",
  description: "A plan with a price",
  category: "content",
  supportsChildren: false,
  schema: { title: { type: "text", default: "Plan" }, price: { type: "text" } },
  keywords: ["subscription"],
  defaults: { price: "€9" },
  actions: [
    { id: "feature", label: "Mark as featured", props: { featured: true }, toolbar: true },
    { id: "plain", label: "Make plain", props: { featured: false } },
  ],
  preview: { mode: "server", minHeight: 120 },
} as BlockCatalogEntry;
const LIVE = { type: "acme.live", version: 1, title: "Live stock", description: "Current stock", category: "content", supportsChildren: false, preview: { mode: "placeholder" } } as BlockCatalogEntry;
const OLD = { type: "acme.old", version: 1, title: "Old card", category: "content", supportsChildren: false, deprecated: { since: "2.0.0" } } as BlockCatalogEntry;
const CATALOG: BlockCatalogEntry[] = [
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
  PRICING,
  LIVE,
  OLD,
];

let previewReply: (body: Record<string, unknown>) => Promise<Response>;
const previews: Record<string, unknown>[] = [];

function mockFetch() {
  previews.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
      if (url.includes("/api/blocks/preview")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        previews.push(body);
        return previewReply(body);
      }
      if (url.includes("/api/blocks")) return ok({ blocks: CATALOG });
      if (url.includes("/api/auth/me")) return ok({ id: "u1", email: "a@example.test", role: "editor", capabilities: ["content:update", "content:locks:manage"] });
      return ok({});
    }),
  );
}

const reply = (status: number, data: unknown = {}) =>
  Promise.resolve({ ok: status < 400, status, json: async () => data } as Response);

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
      compact
    />
  );
}

async function renderBuilder(blocks: BlockNode[]) {
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

const pricing = (props: Record<string, unknown> = { title: "Pro", price: "€29" }, version = 2): BlockNode => ({ id: "b1", type: "acme.pricing", version, props });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setBlockCatalog([]);
});

describe("plugin block preview states", () => {
  it("renders the block's own sanitized html and sends the stored version", async () => {
    previewReply = () => reply(200, { html: '<article><h3>Pro</h3><script>alert(1)</script></article>' });
    await renderBuilder([pricing({ heading: "Old" }, 1)]);
    expect(await screen.findByRole("heading", { name: "Pro" })).toBeInTheDocument();
    expect(document.querySelector("[data-jf-plugin-block] script")).toBeNull();
    expect(previews[0]).toMatchObject({ type: "acme.pricing", version: 1 });
    expect((document.querySelector('[data-jf-plugin-block="acme.pricing"]') as HTMLElement).style.minHeight).toBe("120px");
  });

  it("shows a failure with a retry that renders once the server recovers", async () => {
    let fail = true;
    previewReply = () => (fail ? reply(422, { error: "boom" }) : reply(200, { html: "<p>Recovered</p>" }));
    await renderBuilder([pricing()]);
    expect(await screen.findByText(/Pricing card could not be previewed/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered")).toBeInTheDocument();
  });

  it("names an unavailable block type and an empty render instead of showing nothing", async () => {
    previewReply = (body) => (body.type === "acme.pricing" ? reply(200, { html: "  " }) : reply(404));
    await renderBuilder([pricing(), { id: "b2", type: "acme.gone", version: 1, props: {} }]);
    expect(await screen.findByText(/Pricing card shows nothing/)).toBeInTheDocument();
    expect(await screen.findByText("Unavailable block: acme.gone")).toBeInTheDocument();
  });

  it("shows a placeholder block without asking the server to render it", async () => {
    previewReply = () => reply(200, { html: "<p>should not load</p>" });
    await renderBuilder([{ id: "b3", type: "acme.live", version: 1, props: {} }]);
    expect(await screen.findByText("Current stock")).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(previews).toHaveLength(0);
  });
});

describe("plugin block actions", () => {
  it("runs a declared action from the toolbar and the actions menu as a prop change", async () => {
    previewReply = () => reply(200, { html: "<p>Card</p>" });
    await renderBuilder([pricing()]);
    await screen.findByText("Card");
    fireEvent.click(document.querySelector('[data-block-id="b1"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Mark as featured" }));
    expect(latest.blocks[0]!.props).toMatchObject({ title: "Pro", featured: true });
    /** Only toolbar actions get a toolbar button. */
    expect(screen.queryByRole("button", { name: "Make plain" })).not.toBeInTheDocument();

    fireEvent.contextMenu(document.querySelector('[data-block-id="b1"]')!);
    const menu = await screen.findByRole("menu", { name: "Block actions" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Make plain/ }));
    await waitFor(() => expect(latest.blocks[0]!.props.featured).toBe(false));
  });

  it("disables actions on a block locked against editing", async () => {
    previewReply = () => reply(200, { html: "<p>Card</p>" });
    await renderBuilder([{ ...pricing(), editor: { lock: { edit: true } } } as BlockNode]);
    await screen.findByText("Card");
    fireEvent.click(document.querySelector('[data-block-id="b1"]')!);
    expect(await screen.findByRole("button", { name: "Mark as featured" })).toBeDisabled();
  });
});

describe("inserting plugin blocks", () => {
  it("starts a new block at its registered version with schema and declared defaults", () => {
    setBlockCatalog(CATALOG);
    expect(createBlock("acme.pricing")).toMatchObject({ type: "acme.pricing", version: 2, props: { title: "Plan", price: "€9" } });
    setBlockCatalog([]);
    expect(createBlock("acme.pricing")).toMatchObject({ version: 1, props: {} });
  });

  it("finds blocks by keyword and hides deprecated ones from the library", () => {
    render(
      <I18nProvider>
        <BuilderDragProvider blocks={[]} catalog={new Map(CATALOG.map((e) => [e.type, e]))} onChange={() => {}} onSelect={() => {}}>
          <BlockLibrary catalog={CATALOG} onAdd={() => {}} isPage />
        </BuilderDragProvider>
      </I18nProvider>,
    );
    expect(screen.queryByText("Old card")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search blocks" }), { target: { value: "subscr" } });
    expect(screen.getByText("Pricing card")).toBeInTheDocument();
    expect(screen.queryByText("Paragraph")).not.toBeInTheDocument();
  });
});
