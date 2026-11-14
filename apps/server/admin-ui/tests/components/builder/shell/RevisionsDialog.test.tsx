import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import RevisionsDialog from "../../../../src/components/builder/shell/RevisionsDialog";
import type { BlockNode } from "../../../../src/components/builder/types";

const current: BlockNode[] = [{ id: "a", type: "core.paragraph", version: 1, props: { text: "now" } }];

function renderDialog(overrides: Partial<React.ComponentProps<typeof RevisionsDialog>> = {}) {
  const props: React.ComponentProps<typeof RevisionsDialog> = {
    open: true,
    onClose: vi.fn(),
    loadItems: async () => [
      { id: "r2", createdAt: "2026-11-13T10:00:00Z", authorName: "Ada", state: "Published" },
      { id: "r1", createdAt: "2026-11-12T10:00:00Z", authorName: null },
    ],
    loadBlocks: async (id) =>
      id === "r2"
        ? [{ id: "a", type: "core.paragraph", version: 1, props: { text: "then" } }, { id: "b", type: "core.heading", version: 1, props: {} }]
        : current,
    currentBlocks: current,
    onRestore: vi.fn(async () => {}),
    restoreHint: "Restoring loads this version into the editor.",
    typeLabel: (type) => ({ "core.paragraph": "Paragraph", "core.heading": "Heading" })[type],
    ...overrides,
  };
  render(
    <I18nProvider>
      <RevisionsDialog {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("RevisionsDialog", () => {
  it("lists versions and summarizes what restoring one would change", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByRole("button", { name: /Published · Ada/ }));
    expect(await screen.findByText(/restoring this version would/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Add 1 block/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Change 1 block/ })).toBeInTheDocument();
    expect(screen.getByText("Heading")).toBeInTheDocument();
    expect(screen.getByText("Restoring loads this version into the editor.")).toBeInTheDocument();
  });

  it("says when a version matches what is being edited", async () => {
    const user = userEvent.setup();
    renderDialog();
    const versions = await screen.findAllByRole("button", { pressed: false });
    await user.click(versions.find((button) => !/Ada/.test(button.textContent ?? ""))!);
    expect(await screen.findByText(/same blocks/)).toBeInTheDocument();
  });

  it("restores the selected version and closes", async () => {
    const user = userEvent.setup();
    const props = renderDialog();
    await user.click(await screen.findByRole("button", { name: /Published · Ada/ }));
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    expect(props.onRestore).toHaveBeenCalledWith("r2");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("shows a failed restore and stays open", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ onRestore: vi.fn(async () => { throw new Error("Not saved: newer version exists"); }) });
    await user.click(await screen.findByRole("button", { name: /Published · Ada/ }));
    await user.click(await screen.findByRole("button", { name: "Restore this version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("explains an empty history", async () => {
    renderDialog({ loadItems: async () => [] });
    expect(await screen.findByText(/No earlier versions yet/)).toBeInTheDocument();
  });
});
