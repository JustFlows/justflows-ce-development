import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PatternLibrary from "../../../src/components/builder/PatternLibrary";
import { MemoryRouter } from "react-router-dom";

/**
 * Regression: a pattern whose markup stretches a link over its card (Shop's
 * `.jf-shop__name-link::after { position: absolute; inset: 0 }`) covered the
 * whole dialog, so clicking Insert followed the link instead of inserting.
 */
const pattern = {
  id: "storefront",
  title: "Ecommerce storefront",
  description: "Homepage",
  category: "sections",
  source: "plugin",
  blocks: [{ id: "h", type: "core.html", version: 1, props: { html: '<a href="/shop" class="stretch">Shop now</a>' } }],
};

function respond(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

afterEach(() => vi.unstubAllGlobals());

describe("PatternLibrary preview", () => {
  it("renders the preview inert and contained, and Insert inserts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/patterns/plugin/storefront")) return respond({ pattern });
        if (url.includes("/api/patterns")) return respond({ patterns: [pattern] });
        return respond({});
      }),
    );
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    const onInsert = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <I18nProvider>
          <PatternLibrary catalog={[{ type: "core.html", version: 1, title: "HTML", category: "content", supportsChildren: false }]} currentBlocks={[]} onInsert={onInsert} />
        </I18nProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /Browse patterns/ }));
    await user.click(await screen.findByRole("button", { name: /Ecommerce storefront/ }));
    const link = await screen.findByText("Shop now");
    const frame = link.closest(".jf-pattern-library__frame") as HTMLElement;
    expect(frame).toHaveAttribute("inert");
    expect(frame.style.position).toBe("relative");
    expect(frame.style.contain).toBe("layout paint");
    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledOnce();
  });
});
