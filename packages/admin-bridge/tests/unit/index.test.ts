// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminBridge } from "../../src/index.js";

/**
 * jsdom has no real parent frame, so stub `window.parent` with a spy and drive
 * the protocol by dispatching `message` events as the host would.
 */
const origin = "http://localhost:3000";
let parentPost: ReturnType<typeof vi.fn>;

beforeEach(() => {
  parentPost = vi.fn();
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: { postMessage: parentPost, self: {} } as unknown as Window,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function hostSend(payload: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      source: window.parent,
      data: { source: "justflows-admin-host", ...payload },
    }),
  );
}

describe("createAdminBridge", () => {
  it("posts a namespaced ready message to the host", () => {
    createAdminBridge().ready();
    expect(parentPost).toHaveBeenCalledWith(
      { source: "justflows-admin-plugin", type: "ready" },
      origin,
    );
  });

  it("delivers context and replays it to late subscribers", () => {
    const bridge = createAdminBridge();
    const early = vi.fn();
    bridge.onContext(early);

    const ctx = { locale: "nl", adminBase: "/admin", routePath: "/admin/plugins/acme.forms", theme: "dark" };
    hostSend({ type: "context", context: ctx });

    expect(early).toHaveBeenCalledWith(ctx);
    expect(bridge.context()).toEqual(ctx);

    const late = vi.fn();
    bridge.onContext(late);
    expect(late).toHaveBeenCalledWith(ctx);
  });

  it("routes host navigation and folds it into the stored context", () => {
    const bridge = createAdminBridge();
    hostSend({
      type: "context",
      context: { locale: "en", adminBase: "/admin", routePath: "/admin/plugins/acme.forms", theme: "" },
    });
    const onRoute = vi.fn();
    bridge.onRoute(onRoute);

    hostSend({ type: "route", routePath: "/admin/plugins/acme.forms/submissions" });

    expect(onRoute).toHaveBeenCalledWith("/admin/plugins/acme.forms/submissions");
    expect(bridge.context()?.routePath).toBe("/admin/plugins/acme.forms/submissions");
  });

  it("ignores messages from the wrong origin or source", () => {
    const bridge = createAdminBridge();
    const onContext = vi.fn();
    bridge.onContext(onContext);

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "http://evil.example",
        source: window.parent,
        data: { source: "justflows-admin-host", type: "context", context: { locale: "x" } },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin,
        source: window.parent,
        data: { source: "somebody-else", type: "context", context: { locale: "x" } },
      }),
    );

    expect(onContext).not.toHaveBeenCalled();
  });

  it("forwards navigate requests and reports height", () => {
    const bridge = createAdminBridge();
    bridge.navigate("/admin/plugins/acme.forms/submissions");
    bridge.reportHeight(742);
    expect(parentPost).toHaveBeenCalledWith(
      { source: "justflows-admin-plugin", type: "navigate", path: "/admin/plugins/acme.forms/submissions" },
      origin,
    );
    expect(parentPost).toHaveBeenCalledWith(
      { source: "justflows-admin-plugin", type: "resize", height: 742 },
      origin,
    );
  });

  it("saves when the host posts save", () => {
    const bridge = createAdminBridge();
    const onSave = vi.fn();
    bridge.onSave(onSave);
    hostSend({ type: "save", requestId: "save-1" });
    expect(onSave).toHaveBeenCalledWith("save-1");
    bridge.reportSaved("save-1", false, "nope");
    expect(parentPost).toHaveBeenCalledWith(
      { source: "justflows-admin-plugin", type: "saved", requestId: "save-1", ok: false, error: "nope" },
      origin,
    );
    bridge.reportDirty(true);
    expect(parentPost).toHaveBeenCalledWith(
      { source: "justflows-admin-plugin", type: "dirty", dirty: true },
      origin,
    );
  });

  it("publishes editor sections and hears the host selection", () => {
    const bridge = createAdminBridge();
    const onSection = vi.fn();
    bridge.onSection(onSection);
    bridge.reportSections([
      { id: "images", label: "Images" },
      { id: "pricing", label: "Pricing" },
    ]);
    expect(parentPost).toHaveBeenCalledWith(
      {
        source: "justflows-admin-plugin",
        type: "sections",
        sections: [
          { id: "images", label: "Images" },
          { id: "pricing", label: "Pricing" },
        ],
      },
      origin,
    );
    hostSend({ type: "section", sectionId: "pricing" });
    expect(onSection).toHaveBeenCalledWith("pricing");
    expect(bridge.context()?.sectionId).toBeUndefined();
    hostSend({ type: "context", context: { locale: "en", sectionId: "images" } });
    hostSend({ type: "section", sectionId: "inventory" });
    expect(bridge.context()?.sectionId).toBe("inventory");
  });

  it("stops listening after destroy", () => {
    const bridge = createAdminBridge();
    const onContext = vi.fn();
    bridge.onContext(onContext);
    bridge.destroy();
    hostSend({ type: "context", context: { locale: "en" } });
    expect(onContext).not.toHaveBeenCalled();
  });
});
