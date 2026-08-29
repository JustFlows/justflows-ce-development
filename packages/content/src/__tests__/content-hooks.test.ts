import { describe, it, expect, vi } from "vitest";
import { HooksRegistry, HookAbortError } from "@justflows/core";
import { ContentService } from "../service/content-service.js";

function setup() {
  const hooks = new HooksRegistry({ failureThreshold: 0 });
  return { hooks, content: new ContentService(hooks) };
}

const draft = { siteId: "site-1", title: "Hello world" };

describe("content service hooks", () => {
  it("fires content.created with the new id and site", async () => {
    const { hooks, content } = setup();
    const seen: Array<{ contentId: string; siteId: string; type?: string; translationGroupId?: string }> = [];
    hooks.action("content.created", (e) => { seen.push(e); });

    const item = await content.create(draft);
    expect(seen).toEqual([
      { contentId: item.id, siteId: "site-1", type: "post", translationGroupId: item.id },
    ]);
  });

  it("passes site context to handlers", async () => {
    const { hooks, content } = setup();
    let siteId: string | undefined;
    hooks.action("content.created", (_e, ctx) => { siteId = ctx.siteId; });
    await content.create(draft);
    expect(siteId).toBe("site-1");
  });

  it("content.beforeCreate can block the create", async () => {
    const { hooks, content } = setup();
    hooks.gate<{ input: { title: string } }>(
      "content.beforeCreate",
      (event) => {
        if (event.input.title.includes("spam")) event.cancel("Blocked by the spam filter");
      },
      { pluginId: "acme.spam" },
    );

    await expect(content.create({ siteId: "site-1", title: "buy spam now" })).rejects.toMatchObject({
      name: "HookAbortError",
      reason: "Blocked by the spam filter",
      pluginId: "acme.spam",
    });
    await expect(content.create(draft)).resolves.toMatchObject({ title: "Hello world" });
  });

  it("a blocked create does not fire content.created", async () => {
    const { hooks, content } = setup();
    const created = vi.fn();
    hooks.gate<{ input: unknown }>("content.beforeCreate", (e) => { e.cancel("no"); });
    hooks.action("content.created", created);
    await expect(content.create(draft)).rejects.toBeInstanceOf(HookAbortError);
    expect(created).not.toHaveBeenCalled();
  });

  it("content.beforePublish can block publishing", async () => {
    const { hooks, content } = setup();
    const item = await content.create(draft);
    hooks.gate<{ contentId: string }>("content.beforePublish", (e) => {
      e.cancel("Awaiting editorial review");
    });
    await expect(content.publish(item.id)).rejects.toMatchObject({
      reason: "Awaiting editorial review",
    });
    expect((await content.get(item.id))?.status).toBe("draft");
  });

  it("content.beforeDelete can block deletion", async () => {
    const { hooks, content } = setup();
    const item = await content.create(draft);
    hooks.gate<{ contentId: string }>("content.beforeDelete", (e) => { e.cancel("Locked"); });
    await expect(content.delete(item.id)).rejects.toBeInstanceOf(HookAbortError);
    expect(await content.get(item.id)).toBeDefined();
  });

  it("a failing post-operation action does not undo the operation", async () => {
    const { hooks, content } = setup();
    hooks.action("content.created", () => { throw new Error("analytics is down"); });
    const item = await content.create(draft);
    expect(await content.get(item.id)).toBeDefined();
  });
});
