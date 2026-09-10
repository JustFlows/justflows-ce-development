// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { SearchQuerySchema, searchHighlight, searchTokens } from "./search.js";
describe("search input and highlighting", () => {
  it.each([
    { q: "x".repeat(201) },
    { page: "NaN" },
    { page: 101 },
    { limit: -1 },
    { q: ["a", "b"] },
    { after: "2026-02-30" },
    { after: "2026-03-01", before: "2026-01-01" },
  ])("rejects unbounded/invalid input %j", (value) => {
    expect(SearchQuerySchema.safeParse(value).success).toBe(false);
  });
  it("accepts blank form filters and bounded pagination", () => {
    expect(
      SearchQuerySchema.parse({ q: "  café  ", type: "", after: "", page: "2" }),
    ).toMatchObject({ q: "café", type: undefined, after: undefined, page: 2, limit: 20 });
  });
  it("removes engine syntax and bounds Unicode tokens", () => {
    expect(searchTokens("Café +CAFÉ (星空) -word:* & <b>")).toEqual(["café", "星空", "word", "b"]);
    expect(searchTokens(Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "))).toHaveLength(
      12,
    );
  });
  it("returns lossless text segments without interpreting HTML", () => {
    const text = '<img src=x onerror="alert(1)"> Café';
    const parts = searchHighlight(text, "café");
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.at(-1)).toEqual({ text: "Café", match: true });
    expect(searchHighlight("banana", "ban banana")).toEqual([{ text: "banana", match: true }]);
  });
});
