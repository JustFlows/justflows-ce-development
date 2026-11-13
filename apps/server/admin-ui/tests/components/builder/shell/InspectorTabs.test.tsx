import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import BlockInspector from "../../../../src/components/builder/BlockInspector";
import type { BlockCatalogEntry, BlockNode } from "../../../../src/components/builder/types";

const section: BlockNode = { id: "s1", type: "core.section", version: 1, props: {} };
const entry: BlockCatalogEntry = { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response)));
});
afterEach(() => vi.unstubAllGlobals());

describe("BlockInspector tabs", () => {
  it("groups settings into tabs and moves between them with the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <BlockInspector block={section} catalogEntry={entry} onChange={() => {}} onSyncBlock={() => {}} />
      </I18nProvider>,
    );
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Content", "Style", "Layout", "Responsive", "Interactions", "Advanced"]);
    expect(screen.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", screen.getByRole("tab", { name: "Content" }).id);

    screen.getByRole("tab", { name: "Content" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Style" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Style" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Advanced" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Content" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows device visibility under Responsive and custom CSS under Advanced", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <BlockInspector block={section} catalogEntry={entry} onChange={() => {}} />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole("tab", { name: "Responsive" }));
    expect(screen.getByRole("button", { name: "mobile" })).toBeInTheDocument();
    expect(screen.queryByText("Custom CSS")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.queryByRole("button", { name: "mobile" })).not.toBeInTheDocument();
  });

  it("follows a controlled tab and reports changes", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(
      <I18nProvider>
        <BlockInspector block={section} catalogEntry={entry} onChange={() => {}} tab="layout" onTabChange={onTabChange} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("tab", { name: "Layout" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "Style" }));
    expect(onTabChange).toHaveBeenCalledWith("style");
  });
});
