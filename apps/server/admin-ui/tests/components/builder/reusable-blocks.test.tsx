import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import ReusableBuilderPage from "../../../src/pages/admin/design/ReusableBuilderPage";
import { resetReusableStore } from "../../../src/lib/reusable-blocks";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/** Reusable blocks as linked references, local copies and their own documents (justflows-ce#304). */

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
  { type: "core.reusable", version: 1, title: "Reusable block", category: "layout", supportsChildren: false },
];
const p = (id: string, text: string): BlockNode => ({ id, type: "core.paragraph", version: 1, props: { text } });
const ref = (id: string, target: string): BlockNode => ({ id, type: "core.reusable", version: 1, props: { ref: target } });

let items: Array<Record<string, unknown>> = [];
let usageTotal = 2;
const calls: { url: string; method: string; body?: unknown }[] = [];

beforeEach(() => {
  resetReusableStore();
  calls.length = 0;
  usageTotal = 2;
  items = [
    { id: "cta", name: "Call to action", revision: 3, updatedAt: "", blocks: [p("src", "Buy now")] },
    { id: "loop-a", name: "Loop A", revision: 1, updatedAt: "", blocks: [p("la", "A"), ref("lr", "loop-b")] },
    { id: "loop-b", name: "Loop B", revision: 1, updatedAt: "", blocks: [ref("lr2", "loop-a")] },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const ok = (data: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => data } as Response);
      if (url.includes("/api/blocks")) return ok({ blocks: CATALOG });
      if (url.includes("/api/auth/me")) return ok({ id: "u1", email: "a@example.test", role: "editor", capabilities: ["content:update"] });
      if (url.includes("/usage")) return ok({ total: usageTotal, contentCount: usageTotal, content: [{ id: "page-1", title: "Home", type: "page", locale: "en", status: "published" }], hiddenContent: 1, templateParts: [], templates: [], menus: [], reusableBlocks: [], patterns: [], truncated: false });
      if (url.endsWith("/api/reusable-blocks/cta") && method === "GET") return ok({ item: items[0] });
      if (url.endsWith("/api/reusable-blocks") && method === "PUT") {
        const next = { ...items[0], draft: { name: body.name, blocks: body.blocks, updatedAt: "" } };
        items[0] = next;
        return ok({ item: next });
      }
      if (url.includes("/cta/publish")) {
        const draft = items[0]!.draft as { blocks: BlockNode[] };
        items[0] = { ...items[0], blocks: draft.blocks, revision: 4, draft: undefined };
        return ok({ item: items[0] });
      }
      if (url.includes("/api/reusable-blocks/cta") && method === "DELETE") {
        return url.includes("confirm=1") ? ok({ ok: true }) : ok({ error: "in use", code: "in_use", usage: { total: usageTotal } }, 409);
      }
      if (url.includes("/api/reusable-blocks")) return ok({ items });
      return ok({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const providers = (ui: React.ReactNode) => (
  <SessionProvider>
    <I18nProvider>{ui}</I18nProvider>
  </SessionProvider>
);

describe("a linked reference on the canvas", () => {
  it("shows the source's content under a link chip, and placeholders for deleted sources and cycles", async () => {
    const doc: BlockDocument = { version: 1, blocks: [ref("r1", "cta"), ref("r2", "deleted"), ref("r3", "loop-a")] };
    render(providers(<PageBuilder value={doc} onChange={() => {}} compact flatCanvas />));
    expect(await screen.findByText("Buy now")).toBeInTheDocument();
    expect(screen.getByText(/Linked: Call to action/)).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText(/“Loop A” is not shown again here/)).toBeInTheDocument();
  });

  it("detaches into a local copy with fresh ids and no link left", async () => {
    let latest: BlockDocument = { version: 1, blocks: [p("before", "Before"), ref("r1", "cta")] };
    function Controlled() {
      const [value, setValue] = useState(latest);
      return (
        <PageBuilder
          value={value}
          onChange={(next) => {
            latest = next;
            setValue(next);
          }}
          compact
          flatCanvas
        />
      );
    }
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(providers(<Controlled />));
    await screen.findByText("Buy now");
    fireEvent.click(document.querySelector('[data-block-id="r1"]')!);
    expect(await screen.findByText(/Used in 2 places, 1 of which you can't open/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Detach (make a local copy)" }));
    expect(latest.blocks).toHaveLength(2);
    const copy = latest.blocks[1]!;
    expect(copy).toMatchObject({ type: "core.paragraph", props: { text: "Buy now" } });
    expect(copy.id).not.toBe("src");
    expect(JSON.stringify(latest)).not.toContain("core.reusable");
  });
});

describe("the reusable block editor", () => {
  const open = () =>
    render(
      providers(
        <MemoryRouter initialEntries={["/admin/reusable/cta?back=%2Fadmin%2Fcontent%2Fp1%2Fbuilder"]}>
          <Routes>
            <Route path="/admin/reusable/:id" element={<ReusableBuilderPage />} />
            <Route path="/admin/content/p1/builder" element={<p>Back on the page</p>} />
          </Routes>
        </MemoryRouter>,
      ),
    );

  it("saves a draft, then publishes after naming how many places change", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    expect(await screen.findByRole("heading", { name: "Call to action" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Site" }));
    expect(await screen.findByText(/Used in 2 places/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/admin/content/page-1/builder");
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && (c.body as { draft?: boolean }).draft === true)).toBe(true));
    expect((calls.find((c) => c.method === "PUT")!.body as { expectedRevision: number }).expectedRevision).toBe(3);

    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/cta/publish"))).toBe(true));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("all 2 places"));
  });

  it("asks twice before deleting a block that is still used, then goes back", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    open();
    await screen.findByRole("heading", { name: "Call to action" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("confirm=1"))).toBe(true));
    expect(confirm).toHaveBeenNthCalledWith(2, expect.stringContaining("used in 2 places"));
    expect(await screen.findByText("Back on the page")).toBeInTheDocument();
  });
});
