import { useT } from "../../i18n/I18nProvider";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from "react";
import { esc, renderMath, safeMediaSrc, sanitizeHref, sanitizeMediaSrc, sanitizeRichText, type InlineFormat } from "@justflows/blocks";
import { loadMediaLibrary, MEDIA_ACCEPT, uploadMedia, type MediaKind, type MediaLibraryItem } from "../../lib/media-library";
import "katex/dist/katex.min.css";

type InlineEditableTag = "div" | "p" | "span" | "cite" | "figcaption" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

interface InlineEditableProps
  extends Omit<HTMLAttributes<HTMLElement>, "onChange" | "children" | "contentEditable"> {
  as: InlineEditableTag;
  /** Rich mode stores/returns sanitized HTML; plain mode stores/returns text only (headings aren't rendered as HTML on the live site). */
  mode?: "rich" | "plain";
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  allowLists?: boolean;
  /** Plain mode only: keep line breaks (Enter inserts one) instead of committing on Enter. */
  multiline?: boolean;
  /** Upper bound on the text length; further typing and pasting is refused. */
  maxLength?: number;
  /** Rich mode toolbar formats; omitted means every format. */
  formats?: InlineFormat[];
  /** Accessible name of the field, e.g. "Heading" or "Image caption". */
  label?: string;
}

/**
 * Text of an editable element as the author sees it. Multiline fields read
 * `innerText`, which keeps line breaks, where the DOM implements it.
 */
export function readEditableText(el: HTMLElement, multiline: boolean): string {
  return multiline && "innerText" in HTMLElement.prototype ? el.innerText : (el.textContent ?? "");
}

export function writeEditableText(el: HTMLElement, value: string, multiline: boolean): void {
  if (multiline && "innerText" in HTMLElement.prototype) el.innerText = value;
  else el.textContent = value;
}

function textLength(el: HTMLElement, multiline: boolean): number {
  return readEditableText(el, multiline).length;
}

/**
 * A WordPress-style inline editor for a single text block: click to place the
 * caret directly in the canvas instead of typing into the inspector textarea.
 * Uncontrolled by design — the DOM owns the text while focused — because a
 * controlled contentEditable fights the browser for the caret position.
 */
export function InlineEditable({
  as: Tag,
  mode = "rich",
  value,
  onCommit,
  placeholder,
  allowLists = true,
  multiline = false,
  maxLength,
  formats,
  label,
  className,
  style,
  ...rest
}: InlineEditableProps) {
  const has = (format: InlineFormat) => !formats || formats.includes(format);
  /** Set by Escape: the next blur restores the stored value instead of committing. */
  const cancelRef = useRef(false);
  const { t } = useT();
  const elRef = useRef<HTMLElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const savedRangeRef = useRef<Range | null>(null);

  // Sync external prop changes (undo/redo, another edit) in — but never while
  // the user is actively typing here, or every render would reset the caret.
  useEffect(() => {
    const el = elRef.current;
    if (!el || document.activeElement === el) return;
    if (mode === "plain") {
      if (readEditableText(el, multiline) !== value) writeEditableText(el, value, multiline);
    } else {
      // Stored value keeps math as a bare `data-formula` placeholder; the
      // canvas shows it rendered, so the live DOM gets the expanded form.
      const displayHtml = renderMath(value);
      if (el.innerHTML !== displayHtml) el.innerHTML = displayHtml;
    }
  }, [value, mode]);

  /**
   * The length limit listens to the native `beforeinput` event, which every
   * kind of text entry fires (typing, IME, dictation, autocorrect); React's
   * synthetic onBeforeInput does not cover all of them.
   */
  useEffect(() => {
    const el = elRef.current;
    if (!el || !maxLength) return;
    const onBeforeInput = (e: InputEvent) => {
      if (!e.inputType.startsWith("insert")) return;
      const sel = window.getSelection();
      const replacing = Boolean(sel && !sel.isCollapsed && el.contains(sel.anchorNode));
      if (!replacing && textLength(el, multiline) + (e.data ?? "").length > maxLength) e.preventDefault();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [maxLength, multiline]);

  const updateToolbarPos = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setToolbarPos({ top: rect.top - 40, left: rect.left });
  }, []);

  useEffect(() => {
    if (!focused) return;
    updateToolbarPos();
    window.addEventListener("scroll", updateToolbarPos, true);
    window.addEventListener("resize", updateToolbarPos);
    return () => {
      window.removeEventListener("scroll", updateToolbarPos, true);
      window.removeEventListener("resize", updateToolbarPos);
    };
  }, [focused, updateToolbarPos]);

  const commit = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    if (mode === "plain") {
      const raw = readEditableText(el, multiline);
      const clean = (multiline ? raw.replace(/\n{3,}/g, "\n\n") : raw.replace(/\s*\n\s*/g, " ")).trim();
      if (readEditableText(el, multiline) !== clean) writeEditableText(el, clean, multiline);
      if (clean !== value) onCommit(clean);
      return;
    }
    // Sanitizing directly would choke on KaTeX's rendered internals (nested
    // spans, inline styles) — strip each math node back to its bare
    // `data-formula` placeholder on a clone first, and sanitize that.
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".jf-math").forEach((node) => {
      node.innerHTML = "";
    });
    const clean = sanitizeRichText(clone.innerHTML);
    const displayHtml = renderMath(clean);
    if (el.innerHTML !== displayHtml) el.innerHTML = displayHtml;
    if (clean !== value) onCommit(clean);
  }, [mode, multiline, onCommit, value]);

  const exec = (command: string, arg?: string) => {
    elRef.current?.focus();
    document.execCommand(command, false, arg);
  };

  // No execCommand covers code/mark/kbd, so selection is wrapped (or, when the
  // caret already sits inside a matching tag, unwrapped) by hand.
  const toggleInlineTag = (tagName: string) => {
    const el = elRef.current;
    el?.focus();
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;

    const node = range.startContainer;
    const anchorEl = node instanceof Element ? node : node.parentElement;
    const existing = anchorEl?.closest(tagName);
    if (existing && el.contains(existing)) {
      const parent = existing.parentNode;
      while (existing.firstChild) parent?.insertBefore(existing.firstChild, existing);
      parent?.removeChild(existing);
      return;
    }

    if (range.collapsed) return;
    const wrapper = document.createElement(tagName);
    try {
      range.surroundContents(wrapper);
    } catch {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    }
    sel.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(wrapper);
    sel.addRange(after);
  };

  const wrapLanguage = () => {
    const el = elRef.current;
    el?.focus();
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer) || range.collapsed) return;
    const code = window.prompt(t("builder.inline.languageCodePrompt"));
    if (!code?.trim()) return;
    const wrapper = document.createElement("span");
    wrapper.lang = code.trim();
    try {
      range.surroundContents(wrapper);
    } catch {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    }
    sel.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(wrapper);
    sel.addRange(after);
  };

  // Stores the note text on the marker itself (`data-footnote`) rather than
  // in any separate list — a whole page's footnotes are numbered and
  // collected into a list only once, at final render, across every block.
  const insertFootnote = () => {
    const el = elRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    const text = window.prompt(t("builder.inline.footnoteTextPrompt"));
    if (!text?.trim()) return;
    const marker = document.createElement("sup");
    marker.className = "jf-footnote-ref";
    marker.setAttribute("data-footnote", text.trim());
    marker.textContent = "†";
    range.collapse(false);
    range.insertNode(marker);
    range.setStartAfter(marker);
    range.setEndAfter(marker);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // Inserted already rendered (not just the bare placeholder) so the canvas
  // shows real typeset math immediately, matching what commit()/renderMath
  // will regenerate from the stored `data-formula` value afterward.
  const insertMath = () => {
    const el = elRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    const formula = window.prompt(t("builder.inline.latexFormulaPrompt"));
    if (!formula?.trim()) return;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderMath(
      `<span class="jf-math" data-formula="${esc(formula.trim())}"></span>`,
    );
    const marker = wrapper.firstElementChild;
    if (!marker) return;
    range.collapse(false);
    range.insertNode(marker);
    range.setStartAfter(marker);
    range.setEndAfter(marker);
    sel.removeAllRanges();
    sel.addRange(range);
  };

  // Selection is lost the moment focus moves into the image picker (a URL
  // field, a file dialog), so the caret position is captured up front and
  // restored right before the browser inserts the <img> at that spot.
  const insertImage = useCallback(
    (url: string) => {
      const el = elRef.current;
      const safeSrc = sanitizeMediaSrc(url);
      if (!el || !safeSrc) return;
      el.focus();
      const sel = window.getSelection();
      const range = savedRangeRef.current;
      if (sel) {
        sel.removeAllRanges();
        if (range && el.contains(range.commonAncestorContainer)) {
          sel.addRange(range);
        } else {
          const fallback = document.createRange();
          fallback.selectNodeContents(el);
          fallback.collapse(false);
          sel.addRange(fallback);
        }
      }
      document.execCommand("insertImage", false, safeSrc);
      setImagePickerOpen(false);
      commit();
    },
    [commit],
  );

  const toolbar =
    mode === "rich" && focused && toolbarPos
      ? createPortal(
          <div
            className="jf-inline-toolbar"
            style={{ top: toolbarPos.top, left: toolbarPos.left }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {has("bold") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              style={{ fontWeight: 700 }}
              title={t("builder.inline.boldTooltip")}
              onClick={() => exec("bold")}
            >
              B
            </button>
            )}
            {has("italic") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              style={{ fontStyle: "italic" }}
              title={t("builder.inline.italicTooltip")}
              onClick={() => exec("italic")}
            >
              I
            </button>
            )}
            {has("underline") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              style={{ textDecoration: "underline" }}
              title={t("builder.inline.underlineTooltip")}
              onClick={() => exec("underline")}
            >
              U
            </button>
            )}
            {has("underline") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              style={{ textDecoration: "line-through" }}
              title={t("builder.inline.strikethroughTooltip")}
              onClick={() => exec("strikeThrough")}
            >
              S
            </button>
            )}
            {has("link") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              title={t("builder.inline.linkTooltip")}
              onClick={() => {
                const sel = window.getSelection();
                const node = sel?.anchorNode;
                const el = elRef.current;
                const anchorEl = node instanceof Element ? node : node?.parentElement;
                const inLink = !!(el && anchorEl && el.contains(anchorEl) && anchorEl.closest("a"));
                if (inLink) {
                  exec("unlink");
                  return;
                }
                const url = window.prompt(t("builder.inline.linkUrlPrompt"))?.trim();
                if (!url) return;
                /** Refuse unsafe links here rather than letting the sanitizer drop them silently. */
                if (sanitizeHref(url) !== url) {
                  window.alert(t("builder.inline.linkRejected"));
                  return;
                }
                exec("createLink", url);
              }}
            >
              🔗
            </button>
            )}
            {has("more") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              title={t("builder.inline.insertImageTooltip")}
              onClick={() => {
                const sel = window.getSelection();
                const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
                savedRangeRef.current =
                  range && elRef.current?.contains(range.commonAncestorContainer) ? range : null;
                setImagePickerOpen(true);
              }}
            >
              🖼
            </button>
            )}
            {allowLists && has("lists") && (
              <>
                <button
                  type="button"
                  className="jf-inline-toolbar__btn"
                  title={t("builder.inline.bulletListTooltip")}
                  onClick={() => exec("insertUnorderedList")}
                >
                  •
                </button>
                <button
                  type="button"
                  className="jf-inline-toolbar__btn"
                  title={t("builder.inline.numberedListTooltip")}
                  onClick={() => exec("insertOrderedList")}
                >
                  1.
                </button>
              </>
            )}
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              title={t("builder.inline.clearFormattingTooltip")}
              onClick={() => exec("removeFormat")}
            >
              ✕
            </button>
            {has("more") && (
            <button
              type="button"
              className="jf-inline-toolbar__btn"
              title={t("builder.inline.moreFormatsTooltip")}
              onClick={() => {
                const sel = window.getSelection();
                const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
                savedRangeRef.current =
                  range && elRef.current?.contains(range.commonAncestorContainer) ? range : null;
                setMoreOpen((v) => !v);
              }}
            >
              ⋯
            </button>
            )}
          </div>,
          document.body,
        )
      : null;

  const imagePicker =
    imagePickerOpen && toolbarPos ? (
      <ImagePickerPopover
        top={toolbarPos.top + 40}
        left={toolbarPos.left}
        onInsert={insertImage}
        onClose={() => {
          setImagePickerOpen(false);
          commit();
        }}
      />
    ) : null;

  // Opening the menu blurs the editable (it's a separate floating panel, not
  // covered by the toolbar's mousedown guard), so the selection captured at
  // open time is restored before each format is actually applied.
  const runInMore = (action: () => void) => {
    const el = elRef.current;
    const sel = window.getSelection();
    const range = savedRangeRef.current;
    if (el && sel) {
      el.focus();
      sel.removeAllRanges();
      if (range && el.contains(range.commonAncestorContainer)) sel.addRange(range);
    }
    action();
    setMoreOpen(false);
    commit();
  };

  const moreFormats =
    moreOpen && toolbarPos ? (
      <MoreFormatsMenu
        top={toolbarPos.top + 40}
        left={toolbarPos.left}
        onClose={() => {
          setMoreOpen(false);
          commit();
        }}
        onInlineCode={() => runInMore(() => toggleInlineTag("code"))}
        onHighlight={() => runInMore(() => toggleInlineTag("mark"))}
        onKeyboard={() => runInMore(() => toggleInlineTag("kbd"))}
        onSubscript={() => runInMore(() => document.execCommand("subscript"))}
        onSuperscript={() => runInMore(() => document.execCommand("superscript"))}
        onLanguage={() => runInMore(wrapLanguage)}
        onFootnote={() => runInMore(insertFootnote)}
        onMath={() => runInMore(insertMath)}
      />
    ) : null;

  return (
    <>
      {toolbar}
      {imagePicker}
      {moreFormats}
      <Tag
        {...rest}
        ref={(el: HTMLElement | null) => {
          elRef.current = el;
        }}
        className={["jf-inline-editable", className].filter(Boolean).join(" ")}
        style={style}
        contentEditable
        role="textbox"
        aria-multiline={mode === "rich" || multiline}
        aria-label={label ?? placeholder}
        dir="auto"
        data-builder-chrome="true"
        data-placeholder={placeholder}
        onFocus={() => {
          cancelRef.current = false;
          setFocused(true);
        }}
        onBlur={(e) => {
          setFocused(false);
          if (cancelRef.current) {
            /** Escape: put the stored value back, unsaved. */
            cancelRef.current = false;
            const el = e.currentTarget;
            if (mode === "plain") writeEditableText(el, value, multiline);
            else el.innerHTML = renderMath(value);
            return;
          }
          // Committing here would reset innerHTML and invalidate the caret
          // position a still-open popover is about to act on.
          if (!imagePickerOpen && !moreOpen) commit();
        }}
        onPaste={(e) => {
          e.preventDefault();
          /** Paste is always plain text: formatting from elsewhere never reaches the document. */
          let text = e.clipboardData.getData("text/plain");
          if (mode === "plain" && !multiline) text = text.replace(/\s*\n\s*/g, " ");
          if (maxLength) {
            const el = e.currentTarget;
            const sel = window.getSelection();
            const selected = sel && el.contains(sel.anchorNode) ? sel.toString().length : 0;
            text = text.slice(0, Math.max(0, maxLength - textLength(el, multiline) + selected));
          }
          if (text) document.execCommand("insertText", false, text);
        }}
        onKeyDown={(e) => {
          /** While an input method is composing, Enter and Escape belong to the IME. */
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape") {
            cancelRef.current = true;
            e.currentTarget.blur();
            return;
          }
          if (mode === "plain" && e.key === "Enter") {
            e.preventDefault();
            if (multiline && e.shiftKey === false && !(e.metaKey || e.ctrlKey)) {
              document.execCommand("insertLineBreak");
              return;
            }
            e.currentTarget.blur();
            return;
          }
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
            const key = e.key.toLowerCase();
            if (mode === "rich" && key === "b") {
              e.preventDefault();
              exec("bold");
            } else if (mode === "rich" && key === "i") {
              e.preventDefault();
              exec("italic");
            } else if (mode === "rich" && key === "u") {
              e.preventDefault();
              exec("underline");
            }
          }
        }}
      />
    </>
  );
}

const MORE_FORMATS: Array<{
  key:
    | "inlineCode"
    | "highlight"
    | "keyboard"
    | "subscript"
    | "superscript"
    | "language"
    | "footnote"
    | "math";
  label: string;
  icon: string;
}> = [
  { key: "inlineCode", label: "builder.inline.format.inlineCode", icon: "</>" },
  { key: "highlight", label: "builder.inline.format.highlight", icon: "🖍" },
  { key: "subscript", label: "builder.inline.format.subscript", icon: "X₂" },
  { key: "superscript", label: "builder.inline.format.superscript", icon: "X²" },
  { key: "keyboard", label: "builder.inline.format.keyboardInput", icon: "⌨" },
  { key: "footnote", label: "builder.inline.format.footnote", icon: "†" },
  { key: "math", label: "builder.inline.format.mathLatex", icon: "√x" },
  { key: "language", label: "builder.inline.format.language", icon: "🌐" },
];

function MoreFormatsMenu({
  top,
  left,
  onClose,
  onInlineCode,
  onHighlight,
  onKeyboard,
  onSubscript,
  onSuperscript,
  onLanguage,
  onFootnote,
  onMath,
}: {
  top: number;
  left: number;
  onClose: () => void;
  onInlineCode: () => void;
  onHighlight: () => void;
  onKeyboard: () => void;
  onSubscript: () => void;
  onSuperscript: () => void;
  onLanguage: () => void;
  onFootnote: () => void;
  onMath: () => void;
}) {
  const { t } = useT();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const handlers = {
    inlineCode: onInlineCode,
    highlight: onHighlight,
    keyboard: onKeyboard,
    subscript: onSubscript,
    superscript: onSuperscript,
    language: onLanguage,
    footnote: onFootnote,
    math: onMath,
  } as const;

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div ref={menuRef} className="jf-inline-more-menu" style={{ top, left }}>
      {MORE_FORMATS.map((item) => (
        <button
          key={item.key}
          type="button"
          className="jf-inline-more-menu__item"
          onClick={handlers[item.key]}
        >
          <span className="jf-inline-more-menu__icon" aria-hidden="true">
            {item.icon}
          </span>
          {t(item.label)}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** The image picker the rich-text toolbar and image blocks use. */
export function ImagePickerPopover(props: { top: number; left: number; onInsert: (url: string) => void; onClose: () => void }) {
  return <MediaPickerPopover kind="image" {...props} />;
}

/**
 * Pick media for a block or rich text: upload a file, paste a URL, or choose a
 * recent library item of the right kind. Unsafe URLs are refused here instead
 * of being dropped later by the sanitizer.
 */
export function MediaPickerPopover({
  kind,
  top,
  left,
  onInsert,
  onClose,
}: {
  kind: MediaKind;
  top: number;
  left: number;
  onInsert: (url: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const popRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [library, setLibrary] = useState<MediaLibraryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadMediaLibrary(kind)
      .then((items) => {
        if (!cancelled) setLibrary(items);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLibrary([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      onInsert(await uploadMedia(file, t));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function insertUrl() {
    const value = url.trim();
    if (!value) return;
    if (sanitizeMediaSrc(value) !== value) {
      setError(t("builder.inline.mediaUrlRejected"));
      return;
    }
    onInsert(value);
  }

  return createPortal(
    <div
      ref={popRef}
      className="jf-inline-image-picker"
      style={{ top, left }}
      role="dialog"
      aria-label={t(`builder.inline.pick.${kind}`)}
      data-builder-chrome="true"
    >
      <div className="jf-inline-image-picker__row">
        <button
          type="button"
          className="jf-btn jf-btn--sm jf-btn--primary"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy ? t("builder.inline.uploading") : t(`builder.inline.upload.${kind}`)}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={MEDIA_ACCEPT[kind]}
          hidden
          onChange={(e) => void handleUpload(e.target.files?.[0])}
        />
      </div>
      <div className="jf-inline-image-picker__row">
        <input
          type="text"
          dir="ltr"
          className="jf-input"
          aria-label={t("builder.inline.mediaUrl")}
          placeholder={kind === "image" ? t("builder.inline.imageUrlPlaceholder") : t("builder.inline.mediaUrlPlaceholder")}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) {
              e.preventDefault();
              insertUrl();
            }
          }}
        />
        <button type="button" className="jf-btn jf-btn--sm" disabled={!url.trim()} onClick={insertUrl}>
          {t("builder.inline.insert")}
        </button>
      </div>
      {error ? (
        <p className="jf-field__hint" role="alert" style={{ color: "var(--jf-danger)" }}>
          {error}
        </p>
      ) : null}
      {library === null ? (
        <p className="jf-field__hint">{t("builder.inline.loadingLibrary")}</p>
      ) : library.length > 0 ? (
        kind === "image" ? (
          <div className="jf-media-library jf-inline-image-picker__library">
            {library.map((item) => (
              <button
                key={item.url}
                type="button"
                className="jf-media-library__item"
                title={item.filename}
                aria-label={item.filename}
                onClick={() => onInsert(item.url)}
              >
                <img src={safeMediaSrc(item.url)} alt="" />
              </button>
            ))}
          </div>
        ) : (
          <ul className="jf-inline-media-list">
            {library.map((item) => (
              <li key={item.url}>
                <button type="button" onClick={() => onInsert(item.url)}>
                  {item.filename}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="jf-field__hint">{t("builder.inline.libraryEmpty")}</p>
      )}
    </div>,
    document.body,
  );
}
