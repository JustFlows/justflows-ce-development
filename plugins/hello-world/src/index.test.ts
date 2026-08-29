import { describe, it, expect, vi } from "vitest";

const mockCtx = {
  pluginId: "justflows.hello-world",
  version: "1.0.0",
  permissions: new Set([] as const),
  hooks: {
    action: vi.fn(),
    filter: vi.fn(),
  },
  settings: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
};

describe("hello-world plugin", () => {
  it("exports a valid manifest", async () => {
    const plugin = (await import("./index.js")).default;
    expect(plugin.manifest.id).toBe("justflows.hello-world");
    expect(plugin.manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(plugin.manifest.name).toBeTruthy();
    expect(Array.isArray(plugin.manifest.permissions)).toBe(true);
    expect(plugin.manifest.registry).toEqual({
      commercialMarketplace: false,
      listed: true,
      free: true,
      comingSoon: false,
    });
  });

  it("exports activate function", async () => {
    const plugin = (await import("./index.js")).default;
    expect(typeof plugin.activate).toBe("function");
  });

  it("registers hooks on activate", async () => {
    const plugin = (await import("./index.js")).default;
    await plugin.activate(mockCtx as unknown as Parameters<typeof plugin.activate>[0]);
    expect(mockCtx.hooks.action).toHaveBeenCalledWith("content.published", expect.any(Function));
    expect(mockCtx.hooks.filter).toHaveBeenCalledWith("theme.css", expect.any(Function));
    expect(mockCtx.logger.info).toHaveBeenCalledWith("Hello World plugin activated");
  });

  it("exports deleteData", async () => {
    const plugin = (await import("./index.js")).default;
    expect(typeof plugin.deleteData).toBe("function");
    await plugin.deleteData(mockCtx as unknown as Parameters<typeof plugin.deleteData>[0]);
    expect(mockCtx.logger.info).toHaveBeenCalledWith("Hello World plugin deleteData (no stored data)");
  });
});
