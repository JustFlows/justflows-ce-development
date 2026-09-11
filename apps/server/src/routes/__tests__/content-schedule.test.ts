// SPDX-License-Identifier: MIT
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: true,
  allow: true,
  found: true,
  save: vi.fn(async () => {}),
}));
vi.mock("../../lib/content-scheduling-db.js", async (original) => ({
  ...(await original<typeof import("../../lib/content-scheduling-db.js")>()),
  setContentSchedule: state.save,
}));
vi.mock("../../lib/db.js", () => ({
  getDb: async () => ({
    query: async (sql: string) =>
      sql.includes("FROM content") && state.found
        ? [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              site_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              type: "custom",
              locale: "nl-NL",
              author_id: "owner",
              status: "scheduled",
              version: 2,
            },
          ]
        : [],
  }),
}));
vi.mock("../../lib/access-policy.js", () => ({ userCan: async () => state.allow }));
vi.mock("../../lib/plugin-runtime.js", () => ({ getRuntimeHooks: () => ({}) }));
vi.mock("../../middleware/auth.js", () => ({
  requireSession: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!state.authenticated) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.session = {
      siteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      userId: "owner",
      role: "author",
    } as never;
    next();
  },
  requireCapability:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));
import router from "../content.js";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/content", router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/content/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/schedule`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  state.authenticated = true;
  state.allow = true;
  state.found = true;
  state.save.mockClear();
});
const input = { publishOn: "2030-01-01T10:00:00Z", unpublishOn: null, expectedVersion: 1 };
const put = (body: unknown = input) =>
  fetch(base, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
describe("schedule route", () => {
  it("requires a session", async () => {
    state.authenticated = false;
    expect((await put()).status).toBe(401);
    expect(state.save).not.toHaveBeenCalled();
  });
  it("enforces resource capabilities", async () => {
    state.allow = false;
    expect((await put()).status).toBe(403);
    expect(state.save).not.toHaveBeenCalled();
  });
  it("rejects unknown content and invalid inputs", async () => {
    state.found = false;
    expect((await put()).status).toBe(404);
    expect((await put({ ...input, publishOn: "bad" })).status).toBe(400);
  });
  it("saves with the session site and actor", async () => {
    expect((await put()).status).toBe(200);
    expect(state.save).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ userId: "owner", siteId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      input,
    );
  });
});
