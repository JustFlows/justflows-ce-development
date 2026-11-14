import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import StylePresetPanel from "../../../src/components/builder/StylePresetPanel";
import BlockLayoutPanel from "../../../src/components/builder/BlockLayoutPanel";
import GlobalStylesPanel from "../../../src/components/builder/GlobalStylesPanel";
import { THEME_PREVIEW_SCOPE } from "../../../src/components/builder/BlockPreview";
import { presetIdFromName, resetStylePresetStore } from "../../../src/lib/style-presets";
import type { BlockCatalogEntry, BlockDocument, BlockNode } from "../../../src/components/builder/types";

/** Style presets, value sources and global styles in the builder (justflows-ce#301). */

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.group", version: 1, title: "Group", category: "layout", supportsChildren: true },
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
];
const PRESETS = [
  { id: "card", name: "Card", style: { radius: "md", padTop: "5" } },
  { id: "hero", name: "Hero", style: { padTop: "7" } },
];
const SCHEMA = {
  colors: { label: "Colors", controls: { "--color-primary": { label: "Primary", type: "color", default: "#3b82f6" } } },
  spacing: { label: "Spacing", controls: { "--block-gap": { label: "Block gap", type: "range", default: 1.5, min: 0.5, max: 4, step: 0.25, unit: "rem" } } },
  identity: { label: "Identity", controls: { siteTitle: { label: "Site title", type: "text", default: "" } } },
};

const calls: { url: string; method: string; body?: unknown }[] = [];
let presets = PRESETS;
let mods: Record<string, Record<string, unknown>> = { colors: { "--color-primary": "#ff0000" }, spacing: { "--block-gap": 1.5 } };

function mockFetch(session = { role: "editor", capabilities: ["content:update"] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      let data: unknown = {};
      if (url.includes("/api/blocks")) data = { blocks: CATALOG };
      else if (url.includes("/api/auth/me")) data = { id: "u1", email: "a@example.test", ...session };
      else if (url.includes("/api/style-presets/publish")) data = { items: presets, published: presets, hasDraft: false };
      else if (url.includes("/api/style-presets") && method === "PUT") {
        presets = [...presets.filter((p) => p.id !== body.id), body];
        data = { item: body };
      } else if (url.includes("/api/style-presets")) data = { items: presets, published: PRESETS, hasDraft: presets !== PRESETS };
      else if (url.includes("/api/themes/customize") && method === "PATCH") {
        mods = body.mods;
        data = { ok: true, mods };
      } else if (url.includes("/api/themes/customize")) {
        data = { schema: SCHEMA, mods, published: { colors: { "--color-primary": "#ff0000" }, spacing: { "--block-gap": 1.5 } }, defaults: { colors: { "--color-primary": "#3b82f6" }, spacing: { "--block-gap": 1.5 } }, hasDraft: false };
      } else if (url.includes("/api/themes/style-tokens")) data = { theme: "Default", tokens: [], blockControls: {} };
      return Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
    }),
  );
}

const wrap = (ui: React.ReactNode) =>
  render(
    <SessionProvider>
      <I18nProvider>{ui}</I18nProvider>
    </SessionProvider>,
  );

beforeEach(() => {
  calls.length = 0;
  presets = PRESETS;
  mods = { colors: { "--color-primary": "#ff0000" }, spacing: { "--block-gap": 1.5 } };
  resetStylePresetStore();
});
afterEach(() => vi.unstubAllGlobals());

describe("presetIdFromName", () => {
  it("makes a safe, unique id", () => {
    expect(presetIdFromName("Hero Banner!", [])).toBe("hero-banner");
    expect(presetIdFromName("Hero Banner", ["hero-banner"])).toBe("hero-banner-2");
    expect(presetIdFromName("123", [])).toBe("preset");
  });
});

describe("StylePresetPanel", () => {
  function Harness({ initial }: { initial: BlockNode }) {
    const [block, setBlock] = useState(initial);
    return (
      <>
        <StylePresetPanel block={block} onChange={(props) => setBlock({ ...block, props })} />
        <output data-testid="props">{JSON.stringify(block.props)}</output>
      </>
    );
  }
  const stored = () => JSON.parse(screen.getByTestId("props").textContent ?? "{}");

  it("links a block to a preset by id only", async () => {
    mockFetch();
    wrap(<Harness initial={{ id: "b", type: "core.group", version: 1, props: {} }} />);
    const select = await screen.findByLabelText("Preset");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(select, { target: { value: "card" } });
    expect(stored()).toEqual({ styleRef: "card" });
    expect(screen.getByText(/Uses the preset “Card”/)).toBeInTheDocument();
  });

  it("saves a block's own values as a new preset, then links the block and clears them", async () => {
    mockFetch();
    wrap(<Harness initial={{ id: "b", type: "core.group", version: 1, props: { style: { padTop: "3", shadow: "sm" } } }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save style as preset…" }));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Soft box" } });
    fireEvent.click(screen.getByRole("button", { name: "Create preset" }));
    await waitFor(() => expect(stored()).toEqual({ styleRef: "soft-box" }));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ id: "soft-box", name: "Soft box", style: { padTop: "3", shadow: "sm" } });
  });

  it("detaches by copying the preset values onto the block", async () => {
    mockFetch();
    wrap(<Harness initial={{ id: "b", type: "core.group", version: 1, props: { styleRef: "card", style: { padTop: "2" } } }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Detach (keep values)" }));
    expect(stored()).toEqual({ style: { padTop: "2", radius: "md" } });
  });

  it("hides library actions from authors", async () => {
    mockFetch({ role: "author", capabilities: ["content:update"] });
    wrap(<Harness initial={{ id: "b", type: "core.group", version: 1, props: { style: { padTop: "3" } } }} />);
    await screen.findByLabelText("Preset");
    expect(screen.queryByRole("button", { name: "Save style as preset…" })).not.toBeInTheDocument();
  });
});

describe("value sources in the layout panel", () => {
  it("names the layer behind each value and resets only that layer", () => {
    const onChange = vi.fn();
    const block: BlockNode = {
      id: "b",
      type: "core.group",
      version: 1,
      props: { styleRef: "card", style: { padTop: "2" }, breakpoints: { mobile: { style: { padBottom: "1" } } } },
    };
    render(
      <I18nProvider>
        <BlockLayoutPanel block={block} onChange={onChange} preset={PRESETS[0]} previewing="mobile" />
      </I18nProvider>,
    );
    expect(screen.getByText(/Set on this block, over the preset “Card”/)).toBeInTheDocument();
    expect(screen.getByText(/Set for Mobile/)).toBeInTheDocument();
    expect(screen.getByText("From the preset “Card”")).toBeInTheDocument();
    expect(screen.getAllByText("From the theme").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Reset Padding bottom to the layer beneath" }));
    expect(onChange).toHaveBeenLastCalledWith({ styleRef: "card", style: { padTop: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset Padding top to the layer beneath" }));
    expect(onChange).toHaveBeenLastCalledWith({ styleRef: "card", breakpoints: { mobile: { style: { padBottom: "1" } } } });
  });
});

describe("GlobalStylesPanel", () => {
  it("shows each token's source, previews a change at once, saves a draft and resets to the theme", async () => {
    mockFetch();
    const surface = document.createElement("div");
    surface.className = THEME_PREVIEW_SCOPE;
    surface.dataset.theme = "light";
    document.body.appendChild(surface);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wrap(<GlobalStylesPanel />);
    const primary = await screen.findByLabelText("Primary");
    expect(primary).toHaveAccessibleDescription("Changed for this site");

    fireEvent.change(primary, { target: { value: "#00ff00" } });
    expect(surface.style.getPropertyValue("--color-primary")).toBe("#00ff00");
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({ draft: true, publish: false, mods: { colors: { "--color-primary": "#00ff00" } } });
    await waitFor(() => expect(surface.style.getPropertyValue("--color-primary")).toBe(""));

    fireEvent.click(screen.getByRole("button", { name: "Reset Primary to the theme's value" }));
    /** Back to the theme's value, but not yet published, and the description says both. */
    expect(screen.getByLabelText("Primary")).toHaveAccessibleDescription("Theme default · unpublished");
    vi.useRealTimers();
    surface.remove();
  });

  it("publishes tokens and presets together and refuses authors", async () => {
    mockFetch();
    presets = [...PRESETS, { id: "new", name: "New", style: {} }];
    wrap(<GlobalStylesPanel />);
    await screen.findByLabelText("Primary");
    const publish = await screen.findByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish).not.toBeDisabled());
    fireEvent.click(publish);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/style-presets/publish"))).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ publish: true });
    vi.unstubAllGlobals();
    resetStylePresetStore();
    mockFetch({ role: "author", capabilities: [] });
    wrap(<GlobalStylesPanel />);
    expect(await screen.findByText("Only administrators and editors can change global styles.")).toBeInTheDocument();
  });

  it("lists presets with usage and offers the Styles tab in the builder", async () => {
    mockFetch();
    const doc: BlockDocument = { version: 1, blocks: [{ id: "g", type: "core.group", version: 1, props: { styleRef: "card" } }] };
    wrap(<PageBuilder value={doc} onChange={() => {}} stylesPanel={<GlobalStylesPanel />} />);
    expect(document.querySelector('[data-jf-block-preview="g"]')?.className).toContain("jf-sp-card");
    fireEvent.click(await screen.findByRole("tab", { name: "Styles" }));
    expect(await screen.findByRole("heading", { name: "Style presets" })).toBeInTheDocument();
    expect(await screen.findByText("Card")).toBeInTheDocument();
  });
});

describe("template defaults in the builder", () => {
  it("names the template layer and shows its value beneath the block's own", () => {
    const onChange = vi.fn();
    const block: BlockNode = { id: "h", type: "core.heading", version: 1, props: { text: "Hi" } };
    render(
      <I18nProvider>
        <BlockLayoutPanel block={block} onChange={onChange} templateLayer={{ name: "page", style: { padTop: "4", textAlign: "center" } }} />
      </I18nProvider>,
    );
    expect(screen.getAllByText("From the template “page”. Edit the template to change it.")).toHaveLength(2);
    expect(screen.getByLabelText("Padding top")).toHaveValue("");
  });

  it("applies a template's default on the canvas without changing the document", async () => {
    mockFetch();
    const doc: BlockDocument = { version: 1, blocks: [{ id: "h", type: "core.paragraph", version: 1, props: { text: "Hi" } }] };
    const onChange = vi.fn();
    wrap(
      <PageBuilder
        value={doc}
        onChange={onChange}
        compact
        flatCanvas
        templateContext={{ slug: "page", defaults: { "core.paragraph": { padTop: "4", textAlign: "center" } } }}
      />,
    );
    await screen.findAllByText("Hi");
    const preview = document.querySelector('[data-jf-block-preview="h"]') as HTMLElement;
    expect(preview.style.paddingTop).toBe("var(--space-4)");
    expect(preview.style.textAlign).toBe("center");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("TemplateDefaultsPanel", () => {
  it("adds a block type, edits its defaults, and removes it", async () => {
    mockFetch();
    const { default: TemplateDefaultsPanel } = await import("../../../src/components/builder/TemplateDefaultsPanel");
    function Harness() {
      const [value, setValue] = useState<Record<string, Record<string, unknown>>>({});
      return (
        <>
          <TemplateDefaultsPanel value={value} onChange={setValue} templateLabel="Page" />
          <output data-testid="defaults">{JSON.stringify(value)}</output>
        </>
      );
    }
    wrap(<Harness />);
    const add = await screen.findByLabelText("Add a block type");
    await waitFor(() => expect(within(add).getAllByRole("option").length).toBeGreaterThan(1));
    fireEvent.change(add, { target: { value: "core.paragraph" } });
    fireEvent.change(await screen.findByLabelText("Padding top"), { target: { value: "5" } });
    expect(JSON.parse(screen.getByTestId("defaults").textContent!)).toEqual({ "core.paragraph": { padTop: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove the defaults for Paragraph" }));
    expect(JSON.parse(screen.getByTestId("defaults").textContent!)).toEqual({});
  });
});
