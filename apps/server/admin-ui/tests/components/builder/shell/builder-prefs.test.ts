import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  DEFAULT_BUILDER_PREFS,
  builderPrefsKey,
  parseBuilderPrefs,
  useBuilderPrefs,
} from "../../../../src/components/builder/shell/builder-prefs";

describe("parseBuilderPrefs", () => {
  it("falls back to defaults for anything unrecognised", () => {
    expect(parseBuilderPrefs(null)).toEqual(DEFAULT_BUILDER_PREFS);
    expect(parseBuilderPrefs({ leftOpen: "no", zoom: 33, breakpoint: "watch", inspectorTab: "x" })).toEqual(DEFAULT_BUILDER_PREFS);
  });

  it("keeps valid values", () => {
    expect(
      parseBuilderPrefs({ leftOpen: false, leftTab: "site", rightOpen: false, breakpoint: "mobile", zoom: 75, inspectorTab: "layout" }),
    ).toEqual({ leftOpen: false, leftTab: "site", rightOpen: false, previewWidth: null, breakpoint: "mobile", zoom: 75, inspectorTab: "layout" });
  });
});

describe("useBuilderPrefs", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("remembers a change per user", () => {
    const { result } = renderHook(() => useBuilderPrefs("user-a"));
    act(() => result.current[1]({ breakpoint: "tablet", leftOpen: false }));
    expect(result.current[0]).toMatchObject({ breakpoint: "tablet", leftOpen: false });
    expect(JSON.parse(localStorage.getItem(builderPrefsKey("user-a"))!)).toMatchObject({ breakpoint: "tablet" });

    const other = renderHook(() => useBuilderPrefs("user-b"));
    expect(other.result.current[0]).toEqual(DEFAULT_BUILDER_PREFS);
    const again = renderHook(() => useBuilderPrefs("user-a"));
    expect(again.result.current[0]).toMatchObject({ breakpoint: "tablet", leftOpen: false });
  });

  it("keeps working when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useBuilderPrefs("user-a"));
    expect(result.current[0]).toEqual(DEFAULT_BUILDER_PREFS);
    act(() => result.current[1]({ zoom: 50 }));
    expect(result.current[0].zoom).toBe(50);
  });
});
