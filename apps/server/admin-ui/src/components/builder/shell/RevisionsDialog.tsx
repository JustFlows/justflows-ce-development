// SPDX-License-Identifier: MIT
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../../i18n/I18nProvider";
import { isEmptySummary, summarizeBlockChanges, type BlockChange, type BlockChangeSummary } from "../block-diff";
import type { BlockNode } from "../types";
/** Builder-only styles load with the builder, not on every admin page (justflows-ce#310). */
import "../../../styles/builder.css";

/** One version in the list. */
export interface RevisionListItem {
  id: string;
  createdAt: string;
  authorName?: string | null;
  /** Short state label, e.g. "Published" or "Draft". */
  state?: string;
}

export interface RevisionsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Versions, newest first. */
  loadItems: () => Promise<RevisionListItem[]>;
  /** One version's blocks, for the comparison with what is being edited. */
  loadBlocks: (id: string) => Promise<BlockNode[] | null>;
  currentBlocks: BlockNode[];
  /** Restore a version; resolves when done. Throwing shows the message. */
  onRestore: (id: string) => Promise<void>;
  /** Explains what restoring does in this context (saves a draft, or loads into the editor). */
  restoreHint: string;
  /** Human name for a block type. */
  typeLabel?: (type: string) => string | undefined;
}

/**
 * Compare and restore earlier versions of the document open in the builder
 * (justflows-ce#302). The comparison is against the editor's current blocks,
 * so it shows exactly what restoring would change, by stable block id.
 */
export default function RevisionsDialog({
  open,
  onClose,
  loadItems,
  loadBlocks,
  currentBlocks,
  onRestore,
  restoreHint,
  typeLabel,
}: RevisionsDialogProps) {
  const { t } = useT();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<RevisionListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [summary, setSummary] = useState<BlockChangeSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open) {
      if (!el.open) {
        if (typeof el.showModal === "function") el.showModal();
        else el.setAttribute("open", "");
      }
      setItems(null);
      setSelected(null);
      setSummary(null);
      setError("");
      loadItems()
        .then(setItems)
        .catch((e: unknown) => {
          setItems([]);
          setError(e instanceof Error ? e.message : String(e));
        });
    } else if (el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, /** Reload only when the dialog opens. */ [open]);

  async function select(id: string) {
    setSelected(id);
    setSummary(null);
    setError("");
    try {
      const blocks = await loadBlocks(id);
      setSummary(summarizeBlockChanges(currentBlocks, blocks ?? []));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function restore() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await onRestore(selected);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const name = (change: BlockChange) => change.label || typeLabel?.(change.type) || change.type;
  const group = (key: keyof BlockChangeSummary, label: string) =>
    summary && summary[key].length > 0 ? (
      <div className="jf-revisions__group">
        <h3>{t(label, { count: summary[key].length })}</h3>
        <ul>
          {summary[key].slice(0, 20).map((change) => (
            <li key={change.id}>{name(change)}</li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <dialog ref={dialog} className="jf-revisions" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <header className="jf-revisions__header">
        <h2 id={titleId}>{t("builder.shell.revisions")}</h2>
        <button type="button" className="jf-btn jf-btn--sm" onClick={onClose}>
          {t("common.close")}
        </button>
      </header>
      <div className="jf-revisions__body">
        <div className="jf-revisions__list">
          {items === null ? (
            <p role="status">{t("builder.shell.revisionsLoading")}</p>
          ) : items.length === 0 ? (
            <p>{t("builder.shell.revisionsEmpty")}</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button" aria-pressed={selected === item.id} onClick={() => void select(item.id)}>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                    <small>
                      {[item.state, item.authorName].filter(Boolean).join(" · ")}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="jf-revisions__detail" aria-live="polite">
          {!selected ? (
            <p>{t("builder.shell.revisionsPick")}</p>
          ) : !summary ? (
            error ? null : <p role="status">{t("builder.shell.revisionsLoading")}</p>
          ) : (
            <>
              <p>{isEmptySummary(summary) ? t("builder.shell.revisionsSame") : t("builder.shell.revisionsCompare")}</p>
              {group("added", "builder.shell.revisionsAdded")}
              {group("removed", "builder.shell.revisionsRemoved")}
              {group("changed", "builder.shell.revisionsChanged")}
              {group("moved", "builder.shell.revisionsMoved")}
              <p className="jf-field__hint">{restoreHint}</p>
              <button type="button" className="jf-btn jf-btn--primary" disabled={busy} onClick={() => void restore()}>
                {busy ? t("common.saving") : t("builder.shell.revisionsRestore")}
              </button>
            </>
          )}
          {error && (
            <p className="jf-alert jf-alert--error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
