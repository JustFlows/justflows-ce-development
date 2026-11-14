import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCK_CLIPBOARD_MIME } from "@justflows/blocks";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import { resetBlockClipboard } from "../../../src/components/builder/builder-clipboard";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/**
 * Multi-select, the block actions menu, shortcuts, the clipboard, and locks in
 * the page builder (justflows-ce#298).
 */

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true },
  { type: "core.group", version: 1, title: "Group", category: "layout", supportsChildren: true },
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
];

const p = (id: string, extra: Partial<BlockNode> = {}): BlockNode => ({
  id,
  type: "core.paragraph",
  version: 1,
  props: { text: `Text ${id}` },
  ...extra,
});

let latest: BlockDocument;

function Controlled({ initial, compact = true }: { initial: BlockDocument; compact?: boolean }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return (
    <PageBuilder
      value={value}
      onChange={(next) => {
        latest = next;
        setValue(next);
      }}
      compact={compact}
    />
  );
}

const saved: { url: string; body: unknown }[] = [];

function mockFetch(session: { role: string; capabilities: string[] }) {
  saved.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") saved.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.includes("/api/blocks")
        ? { blocks: CATALOG }
        : url.includes("/api/auth/me")
          ? { id: "u1", email: "a@example.test", ...session }
          : url.includes("/api/reusable-blocks") && init?.method === "PUT"
            ? { item: { id: "reuse-1", name: "Hero", updatedAt: "" } }
            : {};
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    }),
  );
}

const EDITOR = { role: "editor", capabilities: ["content:update", "content:locks:manage"] };
const AUTHOR = { role: "author", capabilities: ["content:update"] };

async function renderBuilder(blocks: BlockNode[], session = EDITOR, compact = true) {
  mockFetch(session);
  const view = render(
    <SessionProvider>
      <I18nProvider>
        <Controlled initial={{ version: 1, blocks }} compact={compact} />
      </I18nProvider>
    </SessionProvider>,
  );
  await screen.findAllByText("Text a");
  /** Let the session request settle so capabilities are known. */
  await act(async () => {});
  return view;
}

/** The builder's polite live region for action results. */
const status = () => document.querySelector(".jf-drop-status") as HTMLElement;
const row = (id: string) => document.querySelector(`[data-block-id="${id}"]`) as HTMLElement;
const childIds = (blocks: BlockNode[], parent: string): string[] => {
  for (const b of blocks) {
    if (b.id === parent) return (b.children ?? []).map((c) => c.id);
    const nested = childIds(b.children ?? [], parent);
    if (nested.length) return nested;
  }
  return [];
};
const section = (children: BlockNode[]): BlockNode => ({ id: "s1", type: "core.section", version: 1, props: {}, children });

beforeEach(() => resetBlockClipboard());
afterEach(() => vi.unstubAllGlobals());

describe("multi-select and batch actions", () => {
  it("Ctrl+click selects siblings, and Ctrl+G groups them as one undo step", async () => {
    await renderBuilder([section([p("a"), p("b"), p("c")])]);
    fireEvent.click(row("a"));
    fireEvent.click(row("c"), { ctrlKey: true });
    expect(await screen.findByText("2 blocks selected")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "g", ctrlKey: true });
    const groupId = childIds(latest.blocks, "s1").find((id) => id !== "b")!;
    expect(childIds(latest.blocks, "s1")).toEqual([groupId, "b"]);
    expect(childIds(latest.blocks, groupId)).toEqual(["a", "c"]);
    await waitFor(() => expect(status()).toHaveTextContent("Grouped 2 blocks."));

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(childIds(latest.blocks, "s1")).toEqual(["a", "b", "c"]);
  });

  it("refuses to add a block from another container to the selection, and says why", async () => {
    await renderBuilder([section([p("a")]), { id: "s2", type: "core.section", version: 1, props: {}, children: [p("x")] }]);
    fireEvent.click(row("a"));
    fireEvent.click(row("x"), { ctrlKey: true });
    await waitFor(() => expect(status()).toHaveTextContent("Multi-select only works for blocks in the same container."));
    expect(screen.queryByText(/blocks selected/)).not.toBeInTheDocument();
  });

  it("duplicates with fresh ids and deletes several blocks at once", async () => {
    await renderBuilder([section([p("a"), p("b")])]);
    fireEvent.click(row("a"));
    fireEvent.click(row("b"), { shiftKey: true });
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    const ids = childIds(latest.blocks, "s1");
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(0, 2)).toEqual(["a", "b"]);

    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(childIds(latest.blocks, "s1")).toEqual(["a", "b"]);
  });
});

describe("actions menu", () => {
  it("opens on right-click with the reasons for unavailable actions", async () => {
    await renderBuilder([section([p("a")])]);
    fireEvent.contextMenu(row("a"));
    const menu = await screen.findByRole("menu", { name: "Block actions" });
    const ungroup = within(menu).getByRole("menuitem", { name: /Ungroup/ });
    expect(ungroup).toHaveAttribute("aria-disabled", "true");
    expect(ungroup).toHaveAccessibleDescription("Only a Group or Container can be ungrouped.");
    expect(within(menu).getByRole("menuitem", { name: /Duplicate/ })).not.toHaveAttribute("aria-disabled");
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: /Duplicate/ }));
    expect(childIds(latest.blocks, "s1")).toHaveLength(2);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape without doing anything", async () => {
    await renderBuilder([section([p("a")])]);
    fireEvent.contextMenu(row("a"));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(childIds(latest.blocks, "s1")).toEqual(["a"]);
  });
});

describe("clipboard", () => {
  it("copies blocks as builder data and pastes them back with new ids", async () => {
    await renderBuilder([section([p("a"), p("b")])]);
    fireEvent.click(row("a"));
    const stored: Record<string, string> = {};
    fireEvent.copy(document.body, { clipboardData: { setData: (type: string, value: string) => (stored[type] = value) } });
    expect(stored[BLOCK_CLIPBOARD_MIME]).toContain("justflows/blocks");

    fireEvent.paste(document.body, { clipboardData: { getData: (type: string) => stored[type] ?? "" } });
    const ids = childIds(latest.blocks, "s1");
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe("a");
    expect(ids[1]).not.toBe("a");
    expect(ids[2]).toBe("b");
  });

  it("pastes ordinary text as escaped paragraphs, never as markup", async () => {
    await renderBuilder([section([p("a")])]);
    fireEvent.click(row("a"));
    fireEvent.paste(document.body, {
      clipboardData: { getData: (type: string) => (type === "text/plain" ? '<img src=x onerror="alert(1)">' : "") },
    });
    const pasted = latest.blocks[0]!.children![1]!;
    expect(pasted.type).toBe("core.paragraph");
    expect(pasted.props.text).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("leaves paste alone while a text field has focus", async () => {
    await renderBuilder([section([p("a")])]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.paste(input, { clipboardData: { getData: () => "Hello" } });
    expect(childIds(latest.blocks, "s1")).toEqual(["a"]);
    input.remove();
  });
});

describe("locks", () => {
  const locked = (flags: Record<string, true>) => p("a", { editor: { lock: flags } });

  it("keeps a remove-locked block on Delete and explains why", async () => {
    await renderBuilder([section([locked({ remove: true }), p("b")])]);
    fireEvent.click(row("a"));
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(childIds(latest.blocks, "s1")).toEqual(["a", "b"]);
    await waitFor(() => expect(status()).toHaveTextContent("locked against removal"));
    expect(within(row("a")).getByRole("button", { name: "Remove block" })).toBeDisabled();
  });

  it("disables the settings of an edit-locked block", async () => {
    await renderBuilder([section([locked({ edit: true })])]);
    fireEvent.click(row("a"));
    const notice = await screen.findByRole("note");
    expect(notice).toHaveTextContent("Unlock it from the block menu");
    expect(notice.closest("fieldset")).toBeDisabled();
  });

  it("lets someone who can manage locks unlock a block from the menu", async () => {
    await renderBuilder([section([locked({ remove: true })])]);
    fireEvent.contextMenu(row("a"));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Prevent removing/ });
    expect(item).toHaveAttribute("aria-checked", "true");
    fireEvent.click(item);
    expect(latest.blocks[0]!.children![0]!.editor).toBeUndefined();
  });

  it("shows locks read-only to someone who cannot manage them", async () => {
    await renderBuilder([section([locked({ remove: true })])], AUTHOR);
    fireEvent.contextMenu(row("a"));
    const item = await screen.findByRole("menuitemcheckbox", { name: /Prevent removing/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Only people who can manage locks can change these.");
    fireEvent.click(item);
    expect(latest.blocks[0]!.children![0]!.editor).toEqual({ lock: { remove: true } });
  });

  it("does not let a copy keep the original's locks", async () => {
    await renderBuilder([section([locked({ remove: true, edit: true })])]);
    fireEvent.click(row("a"));
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    await waitFor(() => expect(childIds(latest.blocks, "s1")).toHaveLength(2));
    expect(latest.blocks[0]!.children![1]!.editor).toBeUndefined();
  });
});

describe("Layers panel selection", () => {
  it("extends the selection with Shift+arrows and opens actions with Shift+F10", async () => {
    await renderBuilder([section([p("a"), p("b")])], EDITOR, false);
    fireEvent.click(await screen.findByRole("tab", { name: "Layers" }));
    const tree = await screen.findByRole("tree");
    expect(tree).toHaveAttribute("aria-multiselectable", "true");
    fireEvent.click(within(tree).getByRole("treeitem", { name: /Section/ }));
    /** Expand the section, then select its first child and extend down. */
    fireEvent.keyDown(within(tree).getByRole("treeitem", { name: /Section/ }), { key: "ArrowRight" });
    const first = (await within(tree).findAllByRole("treeitem", { name: /Paragraph/ }))[0]!;
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    await waitFor(() => expect(within(tree).getAllByRole("treeitem", { selected: true })).toHaveLength(2));

    fireEvent.keyDown(first, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Block actions" })).toBeInTheDocument();
  });
});

describe("save selection to the libraries", () => {
  it("saves two blocks as one reusable block and links it in their place", async () => {
    await renderBuilder([section([p("a"), p("b"), p("c")])]);
    fireEvent.click(row("a"));
    fireEvent.click(row("b"), { shiftKey: true });
    fireEvent.contextMenu(row("a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Save as reusable block/ }));
    const dialog = await screen.findByRole("dialog", { name: "Save as reusable block" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Hero" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save & link" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const put = saved.find((s) => s.url.includes("/api/reusable-blocks"))!;
    expect((put.body as { blocks: BlockNode[] }).blocks.map((b) => b.id)).toEqual(["a", "b"]);
    const children = latest.blocks[0]!.children!;
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ type: "core.reusable", props: { ref: "reuse-1" } });
    expect(children[1]!.id).toBe("c");
  });

  it("is unavailable to authors, with the reason", async () => {
    await renderBuilder([section([p("a")])], AUTHOR);
    fireEvent.contextMenu(row("a"));
    const item = await screen.findByRole("menuitem", { name: /Save as pattern/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Only administrators and editors can save to the library.");
  });
});
