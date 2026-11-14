// SPDX-License-Identifier: MIT
import path from "node:path";
import ejs from "ejs";
import { describe, expect, it } from "vitest";
import { textDirection } from "@justflows/blocks";

/** Public pages set the writing direction of their language on `<html>` (justflows-ce#307). */

const layout = path.resolve(process.cwd(), "src/views/layout.ejs");

async function page(locale: string): Promise<string> {
  return ejs.renderFile(layout, {
    locale,
    dir: textDirection(locale),
    title: "Page",
    body: "<main>Content</main>",
    bodyClass: "",
    justflowsVersion: "test",
    cssProviderStylesheets: [],
    hreflangLinks: [],
    footerBlocksHtml: "",
    headExtra: "",
    analyticsHead: "",
    pwaBody: "",
    themeCssHref: "/theme.css",
    t: (key: string) => key,
  }, { strict: false });
}

describe("public page direction", () => {
  it("is right to left for Arabic and Hebrew pages, and unchanged for others", async () => {
    expect(await page("ar")).toMatch(/<html lang="ar"[^>]* dir="rtl"/);
    expect(await page("he")).toMatch(/<html lang="he"[^>]* dir="rtl"/);
    const dutch = await page("nl");
    expect(dutch).toMatch(/<html lang="nl"/);
    expect(dutch).not.toContain('dir="rtl"');
  });
});
