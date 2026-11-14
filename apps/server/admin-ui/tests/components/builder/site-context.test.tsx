import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import SiteContextFrame from "../../../src/components/builder/SiteContextFrame";
import SiteContextPanel from "../../../src/components/builder/SiteContextPanel";
import { DEFAULT_PAGE_HEADER } from "../../../src/lib/page-header";
import {
  rememberBuilderReturn,
  safeBackPath,
  siteRegionEditPath,
  takeBuilderReturn,
  type SiteContextData,
} from "../../../src/lib/site-context";
import type { BlockCatalogEntry, BlockNode } from "../../../src/components/builder/types";

/** A page's surroundings on the canvas and in the Site tab (justflows-ce#303). */

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.section", version: 1, title: "Section", category: "layout", supportsChildren: true },
  { type: "core.paragraph", version: 1, title: "Paragraph", category: "content", supportsChildren: false },
];
const p = (id: string, text: string): BlockNode => ({ id, type: "core.paragraph", version: 1, props: { text } });

const context: SiteContextData = {
  template: {
    slug: "page",
    source: "override-draft",
    templateDefaults: {},
    blocks: [
      { id: "tt", type: "core.post-title", version: 1, props: { level: 1 } },
      { id: "tm", type: "core.post-meta", version: 1, props: {} },
      { id: "tc", type: "core.post-content", version: 1, props: {} },
      { id: "tf", type: "core.template-part", version: 1, props: { slug: "footer" } },
    ],
    candidates: [
      { slug: "page-about", source: null },
      { slug: "page", source: "override-draft" },
      { slug: "singular", source: null },
      { slug: "index", source: "theme" },
    ],
  },
  header: { ref: "__default__", source: "library", config: { ...DEFAULT_PAGE_HEADER, blocks: [p("hb", "Header block")] } },
  footer: { blocks: [p("fb", "Footer text")], source: "theme" },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.includes("/api/blocks") ? { blocks: CATALOG } : url.includes("/api/site/identity") ? { siteTitle: "Acme", logoUrl: "" } : {};
      return Promise.resolve({ ok: true, status: 200, json: async () => data } as Response);
    }),
  );
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe("SiteContextFrame", () => {
  it("draws the template around the content with the page's real title and the footer part", async () => {
    const onEnter = vi.fn();
    wrap(
      <SiteContextFrame context={context} meta={{ title: "About us", publishedAt: null }} onEnter={onEnter}>
        <div data-testid="canvas">page body</div>
      </SiteContextFrame>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "About us" })).toBeInTheDocument();
    expect(screen.getByText("Not published yet")).toBeInTheDocument();
    expect(screen.getByTestId("canvas").closest("[data-site-context='content']")).not.toBeNull();
    expect(screen.getByText("Footer text")).toBeInTheDocument();
    expect(screen.getByText("Header block")).toBeInTheDocument();
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByText(/stand-ins/)).toBeInTheDocument();
  });

  it("opens an impact notice on a region and enters editing only through its button", () => {
    const onEnter = vi.fn();
    wrap(
      <SiteContextFrame context={context} meta={{ title: "About us" }} onEnter={onEnter}>
        <div>body</div>
      </SiteContextFrame>,
    );
    const footer = document.querySelector("[data-site-context='footer']") as HTMLElement;
    fireEvent.click(within(footer).getByText("Footer text"));
    expect(onEnter).not.toHaveBeenCalled();
    expect(within(footer).getByText("Changes appear on every page.")).toBeInTheDocument();
    fireEvent.click(within(footer).getByRole("button", { name: "Edit the footer" }));
    expect(onEnter).toHaveBeenCalledWith("footer", undefined);
  });

  it("shows the template hierarchy with the match marked", () => {
    wrap(
      <SiteContextFrame context={context} meta={{ title: "About us" }} onEnter={() => {}}>
        <div>body</div>
      </SiteContextFrame>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Template “page”/ }));
    const list = screen.getByRole("list", { name: "Template order" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["page-about not set", "page your override, draft", "singular not set", "index from the theme"]);
    expect(items[1]).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Edit this template" }));
  });
});

describe("SiteContextPanel", () => {
  it("lists header, template and footer with their sources and the hierarchy", () => {
    const onEnter = vi.fn();
    wrap(<SiteContextPanel context={context} onEnter={onEnter} />);
    expect(screen.getByText("Site header")).toBeInTheDocument();
    expect(screen.getByText(/from the header library/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]!);
    expect(onEnter).toHaveBeenCalledWith("template", "page");
    expect(screen.getByText("Template order")).toBeInTheDocument();
  });
});

describe("entering and returning", () => {
  it("builds the theme builder link and honours only admin back paths", () => {
    expect(siteRegionEditPath("template", "/admin/content/p1/builder", "page")).toBe("/admin/themes/customize?tab=templates&slug=page&back=%2Fadmin%2Fcontent%2Fp1%2Fbuilder");
    expect(siteRegionEditPath("footer", "/admin/content/p1/builder")).toBe("/admin/themes/customize?tab=footer&back=%2Fadmin%2Fcontent%2Fp1%2Fbuilder");
    expect(safeBackPath("/admin/content/p1/builder")).toBe("/admin/content/p1/builder");
    expect(safeBackPath("//evil.example")).toBeNull();
    expect(safeBackPath("https://evil.example/admin")).toBeNull();
  });

  it("remembers the selection for one return trip", () => {
    rememberBuilderReturn("p1", "b2");
    expect(takeBuilderReturn("other")).toBeNull();
    rememberBuilderReturn("p1", "b2");
    expect(takeBuilderReturn("p1")).toBe("b2");
    expect(takeBuilderReturn("p1")).toBeNull();
  });

  it("restores the remembered block as the selection once the document is loaded", async () => {
    render(
      <SessionProvider>
        <I18nProvider>
          <PageBuilder
            value={{ version: 1, blocks: [p("a", "A"), p("b", "B")] }}
            onChange={() => {}}
            compact
            flatCanvas
            initialSelectedId="b"
          />
        </I18nProvider>
      </SessionProvider>,
    );
    /** B is selected, so it renders as an inline editor; A is the plain one to wait for. */
    await screen.findByText("A");
    expect(document.querySelector('[data-block-id="b"]')).toHaveAttribute("data-selected", "true");
    expect(document.querySelector('[data-block-id="a"]')).not.toHaveAttribute("data-selected");
  });
});
