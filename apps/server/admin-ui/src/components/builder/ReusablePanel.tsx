import { useEffect, useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import { useSessionRole } from "@components/SessionProvider";
import { fetchReusableUsage, loadReusableBlocks, reusablePreviewBlocks, useReusableStore, type ReusableItem, type ReusableUsage } from "../../lib/reusable-blocks";
import type { BlockNode } from "./types";
/** Builder-only styles load with the builder, not on every admin page (justflows-ce#310). */
import "../../styles/builder.css";

export type { ReusableItem } from "../../lib/reusable-blocks";

/** Shared loader so the inspector, the canvas and the library see the same list. */
export function useReusableBlocks() {
  const { items, reload } = useReusableStore();
  return { items, reload };
}

/** "Used in 4 places, 1 of which you can't open" — the impact of changing the source. */
export function usageSummary(t: (key: string, vars?: Record<string, string | number>) => string, usage: ReusableUsage | null): string {
  if (!usage) return t("builder.reusable.usageLoading");
  if (usage.total === 0) return t("builder.reusable.usageNone");
  return usage.hiddenContent > 0
    ? t("builder.reusable.usageHidden", { count: usage.total, hidden: usage.hiddenContent })
    : t("builder.reusable.usage", { count: usage.total });
}

/**
 * The reusable side of the selected block (justflows-ce#304).
 *
 * - A linked reference (`core.reusable`) shows what it links to and where the
 *   source is used, and offers to edit the source (site-wide, with publish),
 *   detach a local copy (no link remains), or point it at another block.
 * - Any other block can be saved to the library: "Save & link" replaces it
 *   with a reference, "Save a copy" leaves it as it is.
 */
export default function ReusablePanel({
  block,
  onConvert,
  onReload,
  items,
  onDetach,
  onEdit,
}: {
  block: BlockNode;
  onConvert: (ref: string) => void;
  onReload: () => void;
  items: ReusableItem[];
  /** Replace the reference with a local copy of these blocks. */
  onDetach?: (blocks: BlockNode[]) => void;
  /** Open the source in the reusable block editor. */
  onEdit?: (id: string) => void;
}) {
  const { t } = useT();
  /**
   * Saving to the reusable-block library is administrator/editor-only on the
   * server; switching a reference between already-saved blocks isn't a write
   * to that library, so it stays open to any content-write role.
   */
  const role = useSessionRole();
  const canSaveReusable = role === "administrator" || role === "editor";
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<ReusableUsage | null>(null);

  const isReference = block.type === "core.reusable";
  const currentRef = typeof block.props.ref === "string" ? block.props.ref : "";
  const target = items.find((item) => item.id === currentRef);

  useEffect(() => {
    if (!isReference || !currentRef || !target) return;
    let alive = true;
    setUsage(null);
    fetchReusableUsage(currentRef)
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(null));
    return () => {
      alive = false;
    };
  }, [isReference, currentRef, target?.revision]);

  async function save(convert: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/reusable-blocks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, blocks: [block] }),
      });
      const body = (await res.json()) as { error?: string; item?: ReusableItem };
      if (!res.ok || !body.item) throw new Error(body.error ?? t("ui.reusablePanel.couldNotSave"));
      onReload();
      void loadReusableBlocks(true);
      setName("");
      if (convert) onConvert(body.item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (isReference) {
    return (
      <section className="jf-block-panel" aria-labelledby={`jf-reuse-${block.id}`}>
        <h3 id={`jf-reuse-${block.id}`}>{t("builder.reusable.linkedTitle")}</h3>
        <p className="jf-block-panel__hint">{t("builder.reusable.referenceHint")}</p>
        <label className="jf-block-panel__field">
          {t("builder.reusable.showing")}
          <select value={currentRef} onChange={(e) => onConvert(e.target.value)}>
            <option value="">—</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {currentRef && !target && <p className="jf-block-panel__error" role="note">{t("builder.reusable.missingRecover")}</p>}
        {target && (
          <>
            <p className="jf-block-panel__hint" aria-live="polite">
              {usageSummary(t, usage)}
            </p>
            {target.draft && <p className="jf-block-panel__hint">{t("builder.reusable.hasDraft")}</p>}
            <div className="jf-block-panel__actions jf-presets__actions">
              {onEdit && canSaveReusable && (
                <button type="button" className="jf-block-panel__apply" onClick={() => onEdit(target.id)}>
                  {t("builder.reusable.editSource")}
                </button>
              )}
              {onDetach && (
                <button
                  type="button"
                  className="jf-block-panel__toggle"
                  onClick={() => {
                    if (!window.confirm(t("builder.reusable.detachConfirm", { name: target.name }))) return;
                    onDetach(reusablePreviewBlocks({ ...target, draft: undefined }));
                  }}
                >
                  {t("builder.reusable.detach")}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    );
  }

  if (!canSaveReusable) return null;

  return (
    <section className="jf-block-panel" aria-labelledby={`jf-reuse-${block.id}`}>
      <h3 id={`jf-reuse-${block.id}`}>{t("builder.reusable.title")}</h3>
      <p className="jf-block-panel__hint">{t("builder.reusable.hint")}</p>
      <label className="jf-block-panel__field">
        {t("builder.reusable.name")}
        <input type="text" value={name} placeholder={t("builder.reusable.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
      </label>
      {error && <p className="jf-block-panel__error">{error}</p>}
      <div className="jf-block-panel__actions">
        <button type="button" className="jf-block-panel__apply" disabled={busy} onClick={() => void save(true)}>
          {t("builder.reusable.saveAndLink")}
        </button>
        <button type="button" className="jf-block-panel__toggle" disabled={busy} onClick={() => void save(false)}>
          {t("builder.reusable.saveCopy")}
        </button>
      </div>
    </section>
  );
}
