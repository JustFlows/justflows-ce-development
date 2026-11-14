import { afterEach, describe, expect, it, vi } from "vitest";
import { blockPreviewCacheSize, clearBlockPreviewCache, requestBlockPreview } from "../../src/lib/block-preview-batch";
import { setBlockCatalog } from "../../src/components/builder/block-defaults";

/** Batched, cancelable and cached plugin previews (justflows-ce#308). */

let sent: Array<Array<{ type: string }>> = [];
function mockFetch(status = 200) {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const { items } = JSON.parse(String(init?.body)) as { items: Array<{ type: string }> };
      sent.push(items);
      return { ok: status === 200, status, json: async () => ({ results: items.map((i) => ({ status: i.type === "acme.gone" ? 404 : 200, body: { html: `<p>${i.type}</p>` } })) }) } as Response;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearBlockPreviewCache();
});

describe("block preview batching", () => {
  it("sends previews asked for together as one request, sharing identical ones", async () => {
    mockFetch();
    const results = await Promise.all([
      requestBlockPreview({ type: "acme.a", props: { x: 1 } }),
      requestBlockPreview({ type: "acme.b", props: {} }),
      requestBlockPreview({ type: "acme.a", props: { x: 1 } }),
      requestBlockPreview({ type: "acme.gone", props: {} }),
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((i) => i.type)).toEqual(["acme.a", "acme.b", "acme.gone"]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 404]);
  });

  it("answers repeats from the cache, never caches failures, and forgets everything when the catalog reloads", async () => {
    mockFetch();
    await requestBlockPreview({ type: "acme.a", props: {} });
    await requestBlockPreview({ type: "acme.gone", props: {} });
    await requestBlockPreview({ type: "acme.a", props: {} });
    expect(sent).toHaveLength(2);
    expect(blockPreviewCacheSize()).toBe(1);
    setBlockCatalog([]);
    expect(blockPreviewCacheSize()).toBe(0);
  });

  it("drops a cancelled request before it is sent, and rejects it", async () => {
    mockFetch();
    const controller = new AbortController();
    const pending = requestBlockPreview({ type: "acme.a", props: {} }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
  });

  it("reports a failed batch per item instead of hanging", async () => {
    mockFetch(429);
    const result = await requestBlockPreview({ type: "acme.a", props: {} });
    expect(result.status).toBe(429);
    expect(blockPreviewCacheSize()).toBe(0);
  });
});
