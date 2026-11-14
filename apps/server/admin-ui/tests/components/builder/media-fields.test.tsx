import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { coreBlocks } from "@justflows/blocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import BlockInspector from "../../../src/components/builder/BlockInspector";
import type { BlockCatalogEntry } from "../../../src/components/builder/types";

/**
 * Every image and media prop in a block's settings is picked from, or
 * uploaded to, the media library. A pasted URL stays possible as a fallback
 * behind "Paste URL", never as the only control.
 */

vi.mock("../../../src/i18n/I18nProvider", () => ({ useT: () => ({ t: (key: string) => key }) }));
vi.mock("../../../src/lib/theme-style-tokens", () => ({ useThemeStyleTokens: () => ({ theme: "", tokens: [], blockControls: {} }) }));

const MEDIA_NAMES = new Set(["src", "poster", "backgroundImage"]);

/** Props that hold one media URL: typed `media`, or a media block's source. */
function mediaProps(schema: Record<string, { type?: string }>): string[] {
  return Object.entries(schema)
    .filter(([name, field]) => field.type === "media" || (MEDIA_NAMES.has(name) && field.type === "url"))
    .map(([name]) => name);
}

const entryOf = (type: string): BlockCatalogEntry => {
  const definition = coreBlocks.find((block) => block.type === type)!;
  return { ...definition, supportsChildren: definition.supportsChildren ?? false } as BlockCatalogEntry;
};

/** True when a field shows the value only as a plain input outside the picker's paste fallback. */
function plainUrlInputs(value: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>("input")].filter((input) => input.value === value && !input.closest("details"));
}

let requests: string[] = [];
function mockMedia() {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.startsWith("/api/media") && init?.method === "POST") {
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ url: "/uploads/new.png" }) } as Response);
      }
      if (url.startsWith("/api/media")) {
        const items = url.includes("kind=video")
          ? [{ url: "/uploads/clip.mp4", filename: "clip.mp4", mimeType: "video/mp4" }]
          : [{ url: "/uploads/photo.jpg", filename: "photo.jpg", mimeType: "image/jpeg" }];
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ items }) } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("no image or media prop is a bare URL box", () => {
  const cases = coreBlocks.flatMap((block) => {
    const names = mediaProps(block.schema as Record<string, { type?: string }>);
    if (!names.length) return [];
    /** Blocks that switch between image and video are checked in both modes, so every dependent field shows. */
    const modes = "mediaType" in block.schema ? ["image", "video"] : [undefined];
    return modes.map((mediaType) => [block.type, mediaType ?? "-", names] as const);
  });

  it("covers the core blocks that hold media", () => {
    const types = new Set(cases.map(([type]) => type));
    for (const type of ["core.image", "core.hero", "core.video", "core.audio", "core.file", "core.cover", "core.media-text"]) expect(types).toContain(type);
  });

  it.each(cases)("%s (%s)", (type, mediaType, names) => {
    const props: Record<string, unknown> = Object.fromEntries(names.map((name) => [name, `/uploads/${name}.bin`]));
    if (mediaType !== "-") props.mediaType = mediaType;
    render(<BlockInspector block={{ id: "b1", type, version: 1, props }} catalogEntry={entryOf(type)} onChange={vi.fn()} compact />);
    for (const name of names) expect(plainUrlInputs(`/uploads/${name}.bin`), name).toEqual([]);
    expect(screen.getAllByRole("button", { name: "mediaField.upload" }).length).toBeGreaterThan(0);
  });
});

describe("picking and uploading", () => {
  it("sets the Hero background from the library", async () => {
    mockMedia();
    const onChange = vi.fn();
    render(<BlockInspector block={{ id: "h", type: "core.hero", version: 1, props: { heading: "Hi" } }} catalogEntry={entryOf("core.hero")} onChange={onChange} compact />);
    fireEvent.click(screen.getByRole("button", { name: "mediaField.selectImage" }));
    fireEvent.click(await screen.findByTitle("photo.jpg"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ heading: "Hi", backgroundImage: "/uploads/photo.jpg" }));
  });

  it("offers only videos for a video source and lists them by name", async () => {
    mockMedia();
    render(<BlockInspector block={{ id: "v", type: "core.video", version: 1, props: {} }} catalogEntry={entryOf("core.video")} onChange={vi.fn()} compact />);
    fireEvent.click(screen.getByRole("button", { name: "mediaField.selectFile" }));
    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
    expect(requests).toContain("GET /api/media?limit=80&kind=video");
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).accept).toBe("video/mp4,video/webm");
  });

  it("uploads into the library for a plugin block's media field", async () => {
    mockMedia();
    const onChange = vi.fn();
    const entry = {
      type: "acme.card",
      version: 1,
      title: "Card",
      category: "content",
      supportsChildren: false,
      schema: { photo: { type: "media", label: "Photo" }, link: { type: "url", label: "Link" } },
    } as BlockCatalogEntry;
    render(<BlockInspector block={{ id: "c", type: "acme.card", version: 1, props: { link: "/about" } }} catalogEntry={entry} onChange={onChange} compact />);
    expect(screen.getByText("Photo")).toBeInTheDocument();
    /** A link stays a normal URL field. */
    expect(plainUrlInputs("/about")).toHaveLength(1);
    const file = new File(["x"], "new.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ photo: "/uploads/new.png", link: "/about" })));
    expect(requests).toContain("POST /api/media");
  });
});
