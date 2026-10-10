// SPDX-License-Identifier: MIT
import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { createBlockRegistrySync } from "@justflows/blocks";
import type { SessionPayload } from "../../../src/lib/auth/session.js";
const mocks = vi.hoisted(() => ({ view: vi.fn() }));
vi.mock("../../../src/lib/account/view.js", () => ({ accountView: mocks.view }));
vi.mock("../../../src/lib/runtime/jf-root.js", () => ({ viewsDir: () => resolve("src/views") }));
import { renderAccountBlocks } from "../../../src/lib/account/render.js";
const session = { userId: "user-a", siteId: "site-a" } as SessionPayload;
beforeEach(() => {
  vi.clearAllMocks(); mocks.view.mockResolvedValue({ sections: [
    { id: "profile", title: "Your profile", cards: [{ title: "Details", fields: [{ label: "Email", value: '<script>unsafe</script>' }] }] },
    { id: "example.orders", title: "Your orders", cards: [] },
  ], workspaces: [], workspace: null, meters: [], siteDomain: null, initialAccount: '{"workspaces":[],"siteDomain":null}' });
});
describe("editable account block rendering", () => {
  it("keeps customized text and block order, and safely hydrates only selected sections", async () => {
    const html = createBlockRegistrySync().renderDocument({ blocks: [
      { type: "core.heading", props: { text: "My dashboard", level: 1 } },
      { type: "core.account", props: { section: "plugins", sectionId: "example.orders" } },
      { type: "core.account", props: { section: "profile", showTitles: false } },
    ] });
    const rendered = await renderAccountBlocks(html, session);
    expect(rendered).toContain("My dashboard"); expect(rendered).toContain("Your orders");
    expect(rendered.indexOf("Your orders")).toBeLessThan(rendered.indexOf("Details"));
    expect(rendered).not.toContain("<script>unsafe"); expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).not.toContain("<h2>Your profile</h2>"); expect(mocks.view).toHaveBeenCalledExactlyOnceWith(session);
  });
  it("never duplicates DOM identities when the same section is placed twice", async () => {
    const block = { type: "core.account", props: { section: "profile" } };
    const html = createBlockRegistrySync().renderDocument({ blocks: [block, block] });
    expect((await renderAccountBlocks(html, session)).match(/id="profile"/g)).toHaveLength(1);
  });
});


it("preserves builder spacing, custom classes and CSS when hydrating", async () => {
  const html = createBlockRegistrySync().renderDocument({ blocks: [{ id: "profile-block", type: "core.account", props: {
    section: "profile", className: "my-profile", css: "color: purple;", style: { padding: { top: 24 } },
  } }] });
  const rendered = await renderAccountBlocks(html, session);
  expect(rendered).toContain("my-profile"); expect(rendered).toContain('id="profile"');
  expect(rendered).not.toContain("Your account details");
});
