// SPDX-License-Identifier: MIT

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory footer template part.
let footer: { doc: unknown; draft: unknown; revision: number } = { doc: null, draft: null, revision: 0 };
const clone = (v: unknown) => (v == null ? null : JSON.parse(JSON.stringify(v)));

vi.mock("../../../../src/lib/rendering/template-parts-db.js", async () => {
  const { DocumentRevisionConflictError } = await import("../../../../src/lib/database/document-revision.js");
  /** Mirrors the table's optimistic check: a stale expected revision writes nothing. */
  const write = (expected: number | undefined, apply: () => void): number => {
    if (expected !== undefined && expected !== footer.revision) {
      throw new DocumentRevisionConflictError(expected, footer.revision);
    }
    apply();
    footer.revision += 1;
    return footer.revision;
  };
  return {
    getTemplatePartDoc: async (_s: string, _part: string, opts: { draft?: boolean } = {}) =>
      clone(opts.draft ? footer.draft : footer.doc),
    getTemplatePartDocs: async () => ({ doc: clone(footer.doc), draft: clone(footer.draft), revision: footer.revision }),
    templatePartHasDraft: async () => footer.draft != null,
    saveTemplatePartDraft: async (_s: string, _p: string, doc: unknown, expected?: number) =>
      write(expected, () => {
        footer = { ...footer, draft: clone(doc) };
      }),
    saveTemplatePartPublished: async (_s: string, _p: string, doc: unknown, expected?: number) =>
      write(expected, () => {
        footer = { ...footer, doc: clone(doc) };
      }),
    publishTemplatePartDoc: async (_s: string, _p: string, doc: unknown, expected?: number) =>
      write(expected, () => {
        footer = { ...footer, doc: clone(doc), draft: null };
      }),
    clearTemplatePartDraftDoc: async () => {
      footer = { ...footer, draft: null };
      return footer.revision;
    },
  };
});

let themeFooterBlocks: unknown[] | null = null;
vi.mock("../../../../src/lib/themes/themes-db.js", () => ({
  getSiteId: async () => "site-1",
  getActiveTheme: async () => ({ theme_id: "justflows.sample", manifest: {} }),
  themeInstalledPath: () => null,
}));
vi.mock("../../../../src/lib/themes/theme-files.js", () => ({
  loadThemeDemoFooter: () => themeFooterBlocks,
}));
vi.mock("../../../../src/lib/cache/cache-revalidate.js", () => ({ revalidateOnUpdate: async () => {} }));
vi.mock("../../../../src/middleware/auth.js", () => ({
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

const { templatePartsRouter } = await import("../../../../src/routes/content/reusable-blocks.js");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/template-parts", templatePartsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  footer = { doc: null, draft: null, revision: 0 };
  themeFooterBlocks = null;
});

describe("GET /api/template-parts/footer", () => {
  it("seeds the editor with the theme's demo/footer.json when nothing is customised", async () => {
    themeFooterBlocks = [{ id: "f1", type: "core.html", version: 1, props: { html: "<p>hi</p>" } }];
    const res = await fetch(`${base}/api/template-parts/footer`);
    const body = (await res.json()) as {
      blocks: unknown[];
      draft: unknown[];
      fromThemeDefault?: boolean;
    };
    expect(body.fromThemeDefault).toBe(true);
    expect(body.blocks).toHaveLength(1);
    expect(body.draft).toEqual([]);
  });

  it("returns the stored footer untouched once one is saved", async () => {
    themeFooterBlocks = [{ id: "f1", type: "core.html", version: 1, props: { html: "<p>x</p>" } }];
    footer = {
      doc: { version: 1, blocks: [{ id: "s1", type: "core.paragraph", version: 1, props: {} }] },
      draft: null,
      revision: 1,
    };
    const res = await fetch(`${base}/api/template-parts/footer`);
    const body = (await res.json()) as { blocks: { type: string }[]; fromThemeDefault?: boolean };
    expect(body.fromThemeDefault).toBeUndefined();
    expect(body.blocks.map((b) => b.type)).toEqual(["core.paragraph"]);
  });

  it("does not seed when the theme ships no footer", async () => {
    themeFooterBlocks = null;
    const res = await fetch(`${base}/api/template-parts/footer`);
    const body = (await res.json()) as { blocks: unknown[]; fromThemeDefault?: boolean };
    expect(body.fromThemeDefault).toBeUndefined();
    expect(body.blocks).toEqual([]);
  });
});

describe("template part revisions", () => {
  async function put(body: Record<string, unknown>) {
    const res = await fetch(`${base}/api/template-parts/footer`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("returns the revision on read and on every save", async () => {
    const first = await put({ blocks: [{ id: "a", type: "core.paragraph", version: 1, props: {} }], draft: true, expectedRevision: 0 });
    expect(first).toMatchObject({ status: 200, body: { revision: 1 } });
    const read = (await (await fetch(`${base}/api/template-parts/footer`)).json()) as Record<string, unknown>;
    expect(read.revision).toBe(1);
  });

  it("answers 409 with document_conflict when another editor saved first", async () => {
    await put({ blocks: [], draft: true, expectedRevision: 0 });
    await put({ blocks: [{ id: "theirs", type: "core.paragraph", version: 1, props: {} }], draft: true, expectedRevision: 1 });
    const mine = await put({ blocks: [{ id: "mine", type: "core.paragraph", version: 1, props: {} }], draft: false, expectedRevision: 1 });
    expect(mine.status).toBe(409);
    expect(mine.body).toMatchObject({ code: "document_conflict", expectedRevision: 1, actualRevision: 2 });
    expect(footer.doc).toBeNull();
  });

  it("still saves without a revision for older clients", async () => {
    await put({ blocks: [], draft: true, expectedRevision: 0 });
    expect((await put({ blocks: [], draft: false })).status).toBe(200);
  });
});
