import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiNotFound } from "../../../src/middleware/api-not-found.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.get("/ext/acme.live/app.js", (_req, res) => {
    res.type("js").send("ok");
  });
  app.use(apiNotFound);
  app.use((_req, res) => {
    res.status(404).type("html").send("<!DOCTYPE html><p>Page not found</p>");
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("apiNotFound", () => {
  it("answers a missing plugin file with an uncached JSON 404", async () => {
    const res = await fetch(`${base}/ext/acme.gone/review.js?v=6`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("does the same for an unknown API route", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("leaves served files and site pages alone", async () => {
    expect(await (await fetch(`${base}/ext/acme.live/app.js`)).text()).toBe("ok");
    const page = await fetch(`${base}/missing-page`);
    expect(page.headers.get("content-type")).toContain("text/html");
  });
});
