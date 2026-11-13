import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../src/i18n/I18nProvider";
import PageBuilder from "../../../../src/components/builder/PageBuilder";
import type { BlockCatalogEntry, BlockDocument } from "../../../../src/components/builder/types";

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true },
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
];

function Controlled(props: Omit<React.ComponentProps<typeof PageBuilder>, "value" | "onChange">) {
  const [value, setValue] = useState<BlockDocument>({ version: 1, blocks: [] });
  return <PageBuilder value={value} onChange={setValue} {...props} />;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (String(input).includes("/api/blocks") ? { blocks: CATALOG } : {}),
      } as Response),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("BuilderShell", () => {
  it("shows the page context without a site-wide warning", async () => {
    render(
      <I18nProvider>
        <Controlled isPage />
      </I18nProvider>,
    );
    const toolbar = await screen.findByRole("toolbar", { name: "Builder tools" });
    expect(within(toolbar).getByText("Page")).toBeInTheDocument();
    expect(screen.queryByText(/every page/)).not.toBeInTheDocument();
  });

  it("warns that footer changes are site-wide", async () => {
    render(
      <I18nProvider>
        <Controlled context="footer" />
      </I18nProvider>,
    );
    expect(await screen.findByText("Global footer", { selector: ".jf-shell__context" })).toBeInTheDocument();
    expect(screen.getByText("Changes appear on every page.")).toBeInTheDocument();
  });

  it("previews at a breakpoint width and zoom, and remembers them", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(
      <I18nProvider>
        <Controlled isPage />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Mobile" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Zoom" }), "75");
    const frame = container.querySelector<HTMLElement>(".jf-shell__frame")!;
    expect(frame.dataset.breakpoint).toBe("mobile");
    expect(frame.style.maxWidth).toBe("390px");
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
    unmount();

    const again = render(
      <I18nProvider>
        <Controlled isPage />
      </I18nProvider>,
    );
    await screen.findByRole("button", { name: "Mobile" });
    expect(again.container.querySelector<HTMLElement>(".jf-shell__frame")!.dataset.breakpoint).toBe("mobile");
  });

  it("collapses and restores the side panels", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Controlled isPage />
      </I18nProvider>,
    );
    const toggle = await screen.findByRole("button", { name: "Blocks" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary", { name: "Blocks" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole("complementary", { name: "Blocks" })).toBeInTheDocument();
  });

  it("renders the stand-alone top bar with save state and exit", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(
      <I18nProvider>
        <Controlled isPage shellBar={{ title: "About us", onExit, saveState: "dirty" }} />
      </I18nProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "About us" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(onExit).toHaveBeenCalledOnce();
  });
});
