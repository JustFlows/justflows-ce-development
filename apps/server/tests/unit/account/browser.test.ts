// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import ejs from "ejs";
import { resolve } from "node:path";

async function accountDom(workspaces: object[], sections: object[]) {
  const data = { workspaces, siteDomain: "example.com" };
  const html = await ejs.renderFile(resolve("src/views/account-sections.ejs"), {
    ...data, initialAccount: JSON.stringify(data), workspace: workspaces[0] ?? null,
    email: "owner@example.com", meters: [], sections,
  });
  document.body.innerHTML = `<button id="sign-out">Sign out</button><p id="account-message"></p>${html}<script id="initial-account" type="application/json">${JSON.stringify(data)}</script>`;
  const dom = { window };
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ meters: [] }) });
  vi.stubGlobal("fetch", fetch);
  vi.resetModules();
  const accountScript = "../../../public-scripts/src/account.ts";
  await import(accountScript);
  return { dom, fetch };
}

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("account browser enhancement", () => {
  it("does not make startup requests for an account without workspaces", async () => {
    const { dom, fetch } = await accountDom([], [{ id: "profile", title: "Profile", cards: [] }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(dom.window.document.getElementById("sign-out")?.onclick).toBeTypeOf("function");

  });
  it("uses initial workspace data and fetches limits only after a selection change", async () => {
    const { dom, fetch } = await accountDom([{ id: "workspace", name: "Demo", status: "active", sites: [] }], [{ id: "workspaces", title: "Workspaces", cards: [] }]);
    expect(fetch).not.toHaveBeenCalled();
    const selector = dom.window.document.getElementById("workspace-select")!;
    selector.dispatchEvent(new dom.window.Event("change"));
    expect(fetch).toHaveBeenCalledWith("/api/account/workspaces/workspace/limits", expect.objectContaining({ credentials: "same-origin" }));
    await vi.waitFor(() => expect(dom.window.document.getElementById("resource-list")!.textContent).not.toContain("Loading"));

  });
  it("initializes actions independently when the workspace section is removed", async () => {
    const { dom, fetch } = await accountDom([{ id: "workspace", name: "Demo", status: "active", sites: [] }], [{ id: "example.account", title: "Example", cards: [{ title: "Plan", actions: [{ label: "Pause", endpoint: "/ext/example/account/plan/pause", confirm: "Pause?" }] }] }]);
    expect(fetch).not.toHaveBeenCalled();
    const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal("confirm", confirm);
    (dom.window.document.querySelector("[data-account-action]") as HTMLButtonElement).click();
    expect(confirm).toHaveBeenCalledWith("Pause?"); expect(fetch).not.toHaveBeenCalled();

  });
});
