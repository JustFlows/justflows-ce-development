import fs from "node:fs";
import path from "node:path";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import { KEYBOARD_PATHS } from "../../../src/components/builder/keyboard-paths";
import { EMBEDDED_EN } from "../../../src/i18n/embedded-en";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/** Accessible authoring in the builder (justflows-ce#307). */

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true },
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
  { type: "core.heading", version: 1, title: "Heading", category: "content", supportsChildren: false },
  { type: "core.image", version: 1, title: "Image", category: "media", supportsChildren: false },
  { type: "core.button", version: 1, title: "Button", category: "content", supportsChildren: false },
];

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/api/blocks")
        ? { blocks: CATALOG }
        : url.includes("/api/auth/me")
          ? { id: "u1", email: "a@example.test", role: "editor", capabilities: ["content:update"] }
          : {};
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    }),
  );
}

let latest: BlockDocument;
function Controlled({ initial, locale }: { initial: BlockDocument; locale?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <PageBuilder
      value={value}
      contentLocale={locale}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
    />
  );
}

async function open(blocks: BlockNode[], locale?: string) {
  mockFetch();
  render(
    <SessionProvider>
      <I18nProvider>
        <Controlled initial={{ version: 1, blocks }} locale={locale} />
      </I18nProvider>
    </SessionProvider>,
  );
  await act(async () => {});
}

afterEach(() => vi.unstubAllGlobals());

const blocks: BlockNode[] = [
  { id: "h", type: "core.heading", version: 1, props: { level: 2, text: "Intro" } },
  { id: "h4", type: "core.heading", version: 1, props: { level: 4, text: "Detail" } },
  { id: "img", type: "core.image", version: 1, props: { src: "/uploads/a.jpg", alt: "" } },
  { id: "btn", type: "core.button", version: 1, props: { label: "", url: "/x" } },
];

describe("accessibility checks in the builder", () => {
  it("count problems on the tab, list them by severity, and jump to the block and its settings", async () => {
    await open(blocks);
    const tab = screen.getByRole("tab", { name: /Checks/ });
    expect(within(tab).getByLabelText("1 problem")).toBeInTheDocument();
    fireEvent.click(tab);
    expect(screen.getByRole("heading", { name: "Accessibility checks" })).toBeInTheDocument();
    expect(screen.getByText(/don't prove a page is accessible/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1 problem" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2 to review" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Heading level jumps from 2 to 4/ }));
    await waitFor(() => expect(document.querySelector('[data-block-id="h4"]')).toHaveAttribute("data-selected", "true"));
    expect(screen.getByRole("tab", { name: "Content", selected: true })).toBeInTheDocument();
  });
});

describe("checks focus the field that fixes them", () => {
  it.each([
    ["No alt text", "img", "alt"],
    ["has no text, so screen readers", "btn", "label"],
    ["Heading level jumps", "h4", "level"],
  ])("%s", async (message, blockId, field) => {
    await open(blocks);
    fireEvent.click(screen.getByRole("tab", { name: /Checks/ }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(message) }));
    await waitFor(() => expect(document.querySelector(`[data-block-id="${blockId}"]`)).toHaveAttribute("data-selected", "true"));
    await waitFor(() => expect(document.activeElement?.closest(`[data-jf-field="${field}"]`)).not.toBeNull());
  });
});

describe("keyboard", () => {
  it("reaches and selects every canvas block from its name", async () => {
    await open(blocks);
    const name = within(document.querySelector('[data-block-id="img"]') as HTMLElement).getByRole("button", { name: /Image/, pressed: false });
    name.focus();
    fireEvent.click(name);
    await waitFor(() => expect(document.querySelector('[data-block-id="img"]')).toHaveAttribute("data-selected", "true"));
    expect(name).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the shortcuts with ? and returns focus when Escape closes them", async () => {
    await open(blocks);
    const opener = screen.getByRole("button", { name: /Shortcuts/ });
    opener.focus();
    fireEvent.keyDown(opener, { key: "?" });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Move into the block above, or out of its container")).toBeInTheDocument();
    expect(within(dialog).getByText("Grid placement fields in the Layout tab")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
  });

  it("does not open the shortcuts while typing", async () => {
    await open(blocks);
    const input = screen.getAllByRole("spinbutton")[0]!;
    fireEvent.keyDown(input, { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
  });

  it("documents a keyboard path for every pointer action, in the dialog and in the docs", () => {
    const file = ["../../docs", "../../../docs", "docs"].map((dir) => path.resolve(process.cwd(), dir, "BUILDER-ACCESSIBILITY.md")).find((f) => fs.existsSync(f))!;
    const docs = fs.readFileSync(file, "utf8");
    for (const entry of KEYBOARD_PATHS) {
      const label = EMBEDDED_EN[`builder.keyboard.path.${entry.id}`];
      expect(label, entry.id).toBeTruthy();
      expect(docs, entry.id).toContain(label!);
      if (entry.keys.length === 0) expect(EMBEDDED_EN[`builder.keyboard.how.${entry.id}`], entry.id).toBeTruthy();
    }
  });
});

describe("right-to-left content", () => {
  it("writes the canvas in the content's language and direction", async () => {
    await open([{ id: "p", type: "core.paragraph", version: 1, props: { text: "مرحبا" } }], "ar");
    const root = document.querySelector(".jf-canvas-root")!;
    expect(root).toHaveAttribute("dir", "rtl");
    expect(root).toHaveAttribute("lang", "ar");
  });

  it("keeps left-to-right content as it was", async () => {
    await open([{ id: "p", type: "core.paragraph", version: 1, props: { text: "Hallo" } }], "nl");
    expect(document.querySelector(".jf-canvas-root")).toHaveAttribute("dir", "ltr");
  });
});
