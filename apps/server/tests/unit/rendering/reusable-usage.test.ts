// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

/** Usage lists name only what the viewer may open; counts cover everything (justflows-ce#304). */

vi.mock("../../../src/lib/rendering/block-references.js", () => ({
  findBlockReferences: async () => ({
    content: [
      { id: "pub", title: "Published", type: "page", locale: "en", status: "published", authorId: "other" },
      { id: "mine", title: "My draft", type: "post", locale: "en", status: "draft", authorId: "me" },
      { id: "theirs", title: "Their draft", type: "post", locale: "en", status: "draft", authorId: "other" },
      { id: "nl", title: "Dutch page", type: "page", locale: "nl", status: "published", authorId: "other" },
    ],
    templateParts: ["footer"],
    templates: [],
    menus: [],
    reusableBlocks: [],
    patterns: [],
    truncated: false,
  }),
}));

const { reusableUsageFor } = await import("../../../src/lib/rendering/reusable-usage.js");

describe("reusableUsageFor", () => {
  it("lists published content the viewer can read and drafts within their editing reach", async () => {
    const access = {
      roleId: "author",
      additionalRoles: [],
      roles: ["author"],
      capabilities: ["content:read", "content:update"],
      policy: { scopes: { "content:update": { ownership: "self" as const }, "content:read": { locales: ["en"] } } },
    };
    const usage = await reusableUsageFor("s", "cta", { userId: "me", access: access as never });
    expect(usage.content.map((c) => c.id)).toEqual(["pub", "mine"]);
    expect(usage.hiddenContent).toBe(2);
    expect(usage.contentCount).toBe(4);
    expect(usage.total).toBe(5);
    expect(JSON.stringify(usage)).not.toContain("authorId");
  });
});
