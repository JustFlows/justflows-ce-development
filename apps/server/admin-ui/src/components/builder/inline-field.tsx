// SPDX-License-Identifier: MIT
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { coreBlocks, normalizeInlineValue, resolveInlineFields, sanitizeHref, type BlockInlineFields, type InlineFieldSpec } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import { InlineEditable } from "./InlineEditable";
import type { BlockNode } from "./types";

/**
 * Inline-editable fields per block type, from the block catalog
 * (justflows-ce#297). A field is editable on the canvas only when its block
 * declares it; nothing is inferred from rendered markup.
 */
export const CORE_INLINE_FIELDS: ReadonlyMap<string, BlockInlineFields> = new Map(
  coreBlocks
    .map((def) => [def.type, resolveInlineFields(def.inline, true)] as const)
    .filter(([, fields]) => Object.keys(fields).length > 0),
);

/** Core blocks' fields are known in the bundle, so they edit inline before the catalog loads. */
export const InlineFieldsContext = createContext<ReadonlyMap<string, BlockInlineFields>>(CORE_INLINE_FIELDS);

export function useInlineSpec(type: string, field: string): InlineFieldSpec | undefined {
  return useContext(InlineFieldsContext).get(type)?.[field];
}

type Tag = "div" | "p" | "span" | "cite" | "figcaption" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

interface InlineFieldProps {
  block: BlockNode;
  field: string;
  /** True while the block is selected and editable. */
  active: boolean;
  as: Tag;
  className?: string;
  placeholder: string;
  label?: string;
  onCommit: (props: Record<string, unknown>) => void;
  /** What shows when the field is not being edited. */
  children: ReactNode;
}

/**
 * One declared inline field: edited in place while its block is selected,
 * shown as `children` otherwise. The committed value is normalized with the
 * same contract the server applies, so the canvas, inspector, and saved
 * document never disagree.
 */
export function InlineField({ block, field, active, as, className, placeholder, label, onCommit, children }: InlineFieldProps) {
  const spec = useInlineSpec(block.type, field);
  if (!active || !spec) return <>{children}</>;
  const value = typeof block.props[field] === "string" ? (block.props[field] as string) : "";
  return (
    <InlineEditable
      as={as}
      className={className}
      mode={spec.mode}
      multiline={spec.multiline ?? spec.mode === "rich"}
      maxLength={spec.maxLength}
      formats={spec.formats}
      allowLists={spec.mode === "rich" && (spec.multiline ?? true)}
      value={value}
      placeholder={placeholder}
      label={label ?? placeholder}
      onCommit={(next) => onCommit({ ...block.props, [field]: normalizeInlineValue(spec, next) })}
    />
  );
}

/**
 * A link target edited next to its block (button URL). Unsafe or malformed
 * URLs are refused with a message instead of being stored as `#`.
 */
export function InlineLinkField({
  value,
  onCommit,
  label,
}: {
  value: string;
  onCommit: (url: string) => void;
  label: string;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  /** Escape blurs too; the blur that follows must not save the abandoned draft. */
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const url = draft.trim();
    if (url === value) return;
    if (url && sanitizeHref(url) !== url) {
      setError(t("builder.inline.linkRejected"));
      return;
    }
    setError("");
    onCommit(url);
  };

  return (
    <span className="jf-inline-link" data-builder-chrome="true" onClick={(e) => e.stopPropagation()}>
      <label>
        <span className="jf-sr-only">{label}</span>
        <input
          type="url"
          dir="ltr"
          value={draft}
          placeholder={t("builder.inline.linkPlaceholder")}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setError("");
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              cancelled.current = true;
              setDraft(value);
              setError("");
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      {error && (
        <span className="jf-inline-link__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
