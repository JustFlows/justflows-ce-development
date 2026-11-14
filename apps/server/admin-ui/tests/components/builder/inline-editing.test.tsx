import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "@components/SessionProvider";
import { I18nProvider } from "../../../src/i18n/I18nProvider";
import PageBuilder from "../../../src/components/builder/PageBuilder";
import { InlineEditable } from "../../../src/components/builder/InlineEditable";
import type { BlockCatalogEntry, BlockDocument } from "../../../src/components/builder/types";
import { batchPreview } from "../../helpers/preview-batch";

const CATALOG: BlockCatalogEntry[] = [
  { type: "core.heading", version: 1, title: "Heading", category: "content", supportsChildren: false },
  { type: "core.button", version: 1, title: "Button", category: "content", supportsChildren: false },
  { type: "core.image", version: 1, title: "Image", category: "media", supportsChildren: false },
  { type: "core.quote", version: 1, title: "Quote", category: "content", supportsChildren: false },
  { type: "core.video", version: 1, title: "Video", category: "media", supportsChildren: false },
  { type: "core.audio", version: 1, title: "Audio", category: "media", supportsChildren: false },
  { type: "core.file", version: 1, title: "File", category: "media", supportsChildren: false },
  {
    type: "acme.card",
    version: 1,
    title: "Card",
    category: "content",
    supportsChildren: false,
    inline: { title: { mode: "plain", maxLength: 40 } },
  },
];

function respond(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/blocks/preview")) {
        return batchPreview(init, () => respond({ html: '<div><h3 data-jf-inline="title">Old title</h3><p data-jf-inline="secret">Not declared</p></div>' }));
      }
      if (url.includes("/api/blocks")) return respond({ blocks: CATALOG });
      if (url.includes("/api/media")) {
        return respond({
          items: [
            { url: "/uploads/new.jpg", filename: "new.jpg", mimeType: "image/jpeg" },
            { url: "/uploads/clip.mp4", filename: "clip.mp4", mimeType: "video/mp4" },
            { url: "/uploads/song.mp3", filename: "song.mp3", mimeType: "audio/mpeg" },
            { url: "/uploads/guide.pdf", filename: "guide.pdf", mimeType: "application/pdf" },
          ],
        });
      }
      return respond({});
    }),
  );
}

function renderBuilder(initial: BlockDocument) {
  let latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <PageBuilder
        value={value}
        onChange={(next) => {
          latest = next;
          setValue(next);
        }}
        compact
      />
    );
  }
  const utils = render(
    <SessionProvider>
      <I18nProvider>
        <Harness />
      </I18nProvider>
    </SessionProvider>,
  );
  return { ...utils, getLatest: () => latest };
}

const blockProps = (doc: BlockDocument, id: string) => doc.blocks.find((b) => b.id === id)!.props;

describe("InlineEditable", () => {
  afterEach(() => vi.unstubAllGlobals());

  function renderField(props: Partial<React.ComponentProps<typeof InlineEditable>> = {}) {
    const onCommit = vi.fn();
    const utils = render(
      <I18nProvider>
        <InlineEditable as="div" mode="plain" value="Start" label="Title" onCommit={onCommit} {...props} />
      </I18nProvider>,
    );
    return { onCommit, el: utils.getByRole("textbox", { name: "Title" }) };
  }

  it("is a labelled textbox with automatic text direction", () => {
    const { el } = renderField();
    expect(el).toHaveAttribute("dir", "auto");
    expect(el).toHaveAttribute("aria-multiline", "false");
  });

  it("leaves Enter to the input method while composing", () => {
    const { el, onCommit } = renderField();
    el.focus();
    el.textContent = "日本";
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(enter, "isComposing", { value: true });
    el.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(el);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on Enter for a single-line field", () => {
    const { el, onCommit } = renderField();
    el.focus();
    el.textContent = "New title";
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("New title");
  });

  it("cancels with Escape and restores the stored value", () => {
    const { el, onCommit } = renderField();
    el.focus();
    el.textContent = "Abandoned";
    fireEvent.keyDown(el, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.textContent).toBe("Start");
  });

  it("refuses typing past maxLength", () => {
    const { el } = renderField({ maxLength: 5, value: "12345" });
    el.focus();
    const input = new InputEvent("beforeinput", { data: "6", inputType: "insertText", bubbles: true, cancelable: true });
    el.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
  });

  it("pastes plain text only, on one line for single-line fields", () => {
    const exec = vi.fn();
    document.execCommand = exec;
    const { el } = renderField();
    el.focus();
    fireEvent.paste(el, { clipboardData: { getData: (type: string) => (type === "text/plain" ? "a\n b" : "<b>x</b>") } });
    expect(exec).toHaveBeenCalledWith("insertText", false, "a b");
  });

  it("offers only the formats a field declares", () => {
    const { el } = renderField({ mode: "rich", formats: ["bold"], allowLists: true });
    fireEvent.focus(el);
    expect(screen.getByTitle("Bold (⌘B)")).toBeInTheDocument();
    expect(screen.queryByTitle(/Italic/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Bulleted list|Bullet list/)).not.toBeInTheDocument();
  });

  it("refuses an unsafe link instead of silently dropping it", () => {
    const exec = vi.fn();
    document.execCommand = exec;
    vi.spyOn(window, "prompt").mockReturnValue("javascript:alert(1)");
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { el } = renderField({ mode: "rich" });
    fireEvent.focus(el);
    fireEvent.click(screen.getByTitle(/link/i));
    expect(alert).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalledWith("createLink", expect.anything(), expect.anything());
  });
});

describe("inline fields on the canvas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("edits a button label in place and validates its link", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "b1", type: "core.button", version: 1, props: { label: "Go", url: "/start" } }],
    });
    await user.click(await screen.findByText("Go"));
    const label = await screen.findByRole("textbox", { name: "Button text" });
    label.focus();
    label.textContent = "Start now";
    fireEvent.blur(label);
    await waitFor(() => expect(blockProps(getLatest(), "b1").label).toBe("Start now"));

    const link = screen.getByRole("textbox", { name: "Button link" });
    await user.clear(link);
    await user.type(link, "javascript:alert(1){Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't allowed");
    expect(blockProps(getLatest(), "b1").url).toBe("/start");
    await user.clear(link);
    await user.type(link, "/about{Enter}");
    await waitFor(() => expect(blockProps(getLatest(), "b1").url).toBe("/about"));
  });

  it("edits an image's caption and alt text, and replaces it by double-click", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "i1", type: "core.image", version: 1, props: { src: "/uploads/old.jpg", alt: "", caption: "" } }],
    });
    const img = await waitFor(() => container.querySelector('img[src="/uploads/old.jpg"]') as HTMLElement);
    await user.click(img);
    const onCanvas = (name: string) => waitFor(() => container.querySelector(`[contenteditable="true"][aria-label="${name}"]`) as HTMLElement);
    const alt = await onCanvas("Alt text");
    alt.focus();
    alt.textContent = "A red bicycle";
    fireEvent.blur(alt);
    await waitFor(() => expect(blockProps(getLatest(), "i1").alt).toBe("A red bicycle"));

    const caption = await onCanvas("Caption");
    caption.focus();
    caption.textContent = "Taken in Utrecht";
    fireEvent.blur(caption);
    await waitFor(() => expect(blockProps(getLatest(), "i1").caption).toBe("Taken in Utrecht"));

    await user.dblClick(screen.getByRole("button", { name: "Replace image" }));
    const choice = await screen.findByRole("button", { name: /new\.jpg/ });
    await user.click(choice);
    await waitFor(() => expect(blockProps(getLatest(), "i1").src).toBe("/uploads/new.jpg"));
  });

  it("edits a quote attribution as plain text", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "q1", type: "core.quote", version: 1, props: { text: "To be", attribution: "" } }],
    });
    await user.click(await screen.findByText("To be"));
    const cite = await waitFor(() => container.querySelector('cite[contenteditable="true"]') as HTMLElement);
    cite.focus();
    cite.textContent = "<b>Shakespeare</b>";
    fireEvent.blur(cite);
    await waitFor(() => expect(blockProps(getLatest(), "q1").attribution).toBe("<b>Shakespeare</b>"));
  });

  it("lets a plugin block edit only the props it declared", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "c1", type: "acme.card", version: 1, props: { title: "Old title", secret: "Not declared" } }],
    });
    await user.click(await screen.findByText("Old title"));
    await act(async () => {});
    const title = await waitFor(() => {
      const el = container.querySelector('[data-jf-inline="title"]') as HTMLElement;
      expect(el.getAttribute("contenteditable")).toBe("true");
      return el;
    });
    expect(container.querySelector('[data-jf-inline="secret"]')!.getAttribute("contenteditable")).not.toBe("true");
    title.focus();
    title.textContent = "New title";
    fireEvent.blur(title);
    await waitFor(() => expect(blockProps(getLatest(), "c1").title).toBe("New title"));
    expect(blockProps(getLatest(), "c1").secret).toBe("Not declared");
  });
});

describe("inline media editing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replaces a video from videos only, picks a poster from images, and edits its caption", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "v1", type: "core.video", version: 1, props: { src: "/uploads/old.mp4", caption: "Old" } }],
    });
    const preview = await waitFor(() => container.querySelector("video")!.closest("[data-jf-block-preview], .jf-canvas-block") as HTMLElement);
    await user.click(preview);

    await user.click(await screen.findByRole("button", { name: "Replace video" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a video" });
    expect(within(dialog).queryByRole("button", { name: "new.jpg" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "clip.mp4" }));
    await waitFor(() => expect(blockProps(getLatest(), "v1").src).toBe("/uploads/clip.mp4"));

    await user.click(screen.getByRole("button", { name: "Choose poster image" }));
    const posters = await screen.findByRole("dialog", { name: "Choose an image" });
    await user.click(within(posters).getByRole("button", { name: "new.jpg" }));
    await waitFor(() => expect(blockProps(getLatest(), "v1").poster).toBe("/uploads/new.jpg"));

    const caption = await waitFor(() => container.querySelector('[contenteditable="true"][aria-label="Caption"]') as HTMLElement);
    caption.focus();
    caption.textContent = "Launch film";
    fireEvent.blur(caption);
    await waitFor(() => expect(blockProps(getLatest(), "v1").caption).toBe("Launch film"));
  });

  it("replaces audio with audio files only", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "a1", type: "core.audio", version: 1, props: { src: "/uploads/old.mp3" } }],
    });
    const audio = await waitFor(() => container.querySelector("audio") as HTMLElement);
    await user.click(audio);
    await user.click(await screen.findByRole("button", { name: "Replace audio" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose audio" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toContain("song.mp3");
    expect(within(dialog).queryByRole("button", { name: "clip.mp4" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "song.mp3" }));
    await waitFor(() => expect(blockProps(getLatest(), "a1").src).toBe("/uploads/song.mp3"));
  });

  it("replaces a file and edits its link text", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "f1", type: "core.file", version: 1, props: { src: "/uploads/old.pdf", label: "Old guide" } }],
    });
    await user.click(await screen.findByText("Old guide"));
    await user.click(await screen.findByRole("button", { name: "Replace file" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a file" });
    await user.click(within(dialog).getByRole("button", { name: "guide.pdf" }));
    await waitFor(() => expect(blockProps(getLatest(), "f1").src).toBe("/uploads/guide.pdf"));

    const label = await waitFor(() => container.querySelector('[contenteditable="true"][aria-label="Link text"]') as HTMLElement);
    label.focus();
    label.textContent = "Download the guide";
    fireEvent.blur(label);
    await waitFor(() => expect(blockProps(getLatest(), "f1").label).toBe("Download the guide"));
  });

  it("refuses an unsafe media address in the picker", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { container, getLatest } = renderBuilder({
      version: 1,
      blocks: [{ id: "v1", type: "core.video", version: 1, props: { src: "/uploads/old.mp4" } }],
    });
    await user.click(await waitFor(() => container.querySelector("video") as HTMLElement));
    await user.click(await screen.findByRole("button", { name: "Replace video" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose a video" });
    await user.type(within(dialog).getByRole("textbox", { name: "Media address" }), "javascript:alert(1){Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("can't be used");
    expect(blockProps(getLatest(), "v1").src).toBe("/uploads/old.mp4");
  });
});
