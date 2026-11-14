import { useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import { useOptionalCapability } from "../SessionProvider";
import { createBlock } from "./block-defaults";
import type { BlockCatalogEntry, BlockNode } from "./types";

/**
 * Recovery for a block the builder cannot edit normally (justflows-ce#306):
 * its plugin or theme is not active, or the block is deprecated.
 *
 * Nothing here changes the block on its own. Its type, id, version, settings
 * and children stay exactly as stored until the author picks Replace or
 * Remove, and both ask first. The stored data can be copied or downloaded at
 * any time, and Try again reloads the block list after an extension is
 * switched back on.
 */

export type BlockRecoveryReason = "unavailable" | "deprecated";

function countBlocks(blocks: BlockNode[] | undefined): number {
  return (blocks ?? []).reduce((n, child) => n + 1 + countBlocks(child.children), 0);
}

/**
 * The replacement for a block: the target's defaults, with every stored
 * setting the target also declares carried over, and the children kept when
 * the target accepts children. The id stays, so links and history still point
 * at the same block.
 */
export function replacementBlock(block: BlockNode, target: BlockCatalogEntry): BlockNode {
  const fresh = createBlock(target.type);
  const declared = new Set(Object.keys(target.schema ?? {}));
  const carried = Object.fromEntries(Object.entries(block.props).filter(([key]) => declared.has(key)));
  const next: BlockNode = { ...fresh, id: block.id, props: { ...fresh.props, ...carried } };
  if (target.supportsChildren) next.children = block.children ?? fresh.children ?? [];
  else delete next.children;
  if (block.editor) next.editor = block.editor;
  return next;
}

export default function BlockRecoveryPanel({
  block,
  reason,
  entry,
  catalog,
  onReplace,
  onRemove,
  onRetry,
}: {
  block: BlockNode;
  reason: BlockRecoveryReason;
  /** The catalog entry, for a deprecated block. */
  entry?: BlockCatalogEntry;
  catalog: BlockCatalogEntry[];
  onReplace?: (next: BlockNode) => void;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const { t } = useT();
  const canManagePlugins = useOptionalCapability("plugins:activate");
  const [target, setTarget] = useState(entry?.deprecated?.replacedBy ?? "");
  const [notice, setNotice] = useState("");
  const data = JSON.stringify(block, null, 2);
  const provider = block.type.includes(".") ? block.type.slice(0, block.type.indexOf(".")) : block.type;
  const settings = Object.keys(block.props ?? {}).length;
  const inside = countBlocks(block.children);
  const choices = catalog.filter((c) => !c.deprecated && c.type !== block.type).sort((a, b) => a.title.localeCompare(b.title));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data);
      setNotice(t("builder.recovery.copied"));
    } catch {
      setNotice(t("builder.recovery.copyFailed"));
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${block.type}-${block.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const replace = () => {
    const chosen = catalog.find((c) => c.type === target);
    if (!chosen || !onReplace) return;
    const next = replacementBlock(block, chosen);
    const dropped = Object.keys(block.props).filter((key) => !(key in next.props)).length;
    const lostChildren = inside > 0 && !chosen.supportsChildren;
    const message = [
      t("builder.recovery.replaceConfirm", { title: chosen.title }),
      dropped > 0 ? t("builder.recovery.replaceDrops", { count: dropped }) : "",
      lostChildren ? t("builder.recovery.replaceDropsChildren", { count: inside }) : "",
      dropped > 0 || lostChildren ? t("builder.recovery.downloadFirst") : "",
    ].filter(Boolean).join("\n\n");
    if (!window.confirm(message)) return;
    onReplace(next);
  };

  const remove = () => {
    if (!onRemove) return;
    if (!window.confirm(inside > 0 ? t("builder.recovery.removeConfirmChildren", { count: inside }) : t("builder.recovery.removeConfirm"))) return;
    onRemove();
  };

  return (
    <section className="jf-recovery" aria-labelledby={`recovery-${block.id}`} data-jf-recovery={reason}>
      <h3 id={`recovery-${block.id}`} className="jf-recovery__title">
        {reason === "unavailable" ? t("builder.recovery.unavailableTitle") : t("builder.recovery.deprecatedTitle")}
      </h3>
      <p className="jf-recovery__text">
        {reason === "unavailable"
          ? t("builder.recovery.unavailableText")
          : entry?.deprecated?.replacedBy
            ? t("builder.recovery.deprecatedReplaced", { type: catalog.find((c) => c.type === entry.deprecated!.replacedBy)?.title ?? entry.deprecated.replacedBy })
            : t("builder.recovery.deprecatedText")}
      </p>
      {entry?.deprecated?.message && <p className="jf-recovery__text">{entry.deprecated.message}</p>}

      <dl className="jf-recovery__meta">
        <dt>{t("builder.recovery.type")}</dt>
        <dd><code>{block.type}</code></dd>
        <dt>{t("builder.recovery.providedBy")}</dt>
        <dd><code>{provider}</code></dd>
        <dt>{t("builder.recovery.version")}</dt>
        <dd>{String(block.version ?? 1)}{entry?.deprecated?.since ? ` · ${t("builder.recovery.deprecatedSince", { since: entry.deprecated.since })}` : ""}</dd>
        <dt>{t("builder.recovery.id")}</dt>
        <dd><code>{block.id}</code></dd>
        <dt>{t("builder.recovery.stored")}</dt>
        <dd>{t("builder.recovery.storedCounts", { settings, blocks: inside })}</dd>
      </dl>

      <div className="jf-recovery__actions">
        {reason === "unavailable" && onRetry && (
          <button type="button" className="jf-btn jf-btn--sm" onClick={onRetry}>{t("builder.pluginPreview.retry")}</button>
        )}
        <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={() => void copy()}>{t("builder.recovery.copy")}</button>
        <button type="button" className="jf-btn jf-btn--sm jf-btn--ghost" onClick={download}>{t("builder.recovery.download")}</button>
        {reason === "unavailable" && canManagePlugins && (
          <a className="jf-btn jf-btn--sm jf-btn--ghost" href="/admin/plugins" target="_blank" rel="noopener noreferrer">{t("builder.recovery.manageExtensions")}</a>
        )}
      </div>
      {notice && <p className="jf-recovery__notice" role="status">{notice}</p>}

      {onReplace && choices.length > 0 && (
        <div className="jf-recovery__replace">
          <label htmlFor={`recovery-target-${block.id}`}>{t("builder.recovery.replaceWith")}</label>
          <div className="jf-row">
            <select id={`recovery-target-${block.id}`} className="jf-input" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t("builder.recovery.chooseBlock")}</option>
              {choices.map((c) => <option key={c.type} value={c.type}>{c.title}</option>)}
            </select>
            <button type="button" className="jf-btn jf-btn--sm" onClick={replace} disabled={!target}>{t("builder.recovery.replace")}</button>
          </div>
        </div>
      )}
      {onRemove && (
        <button type="button" className="jf-btn jf-btn--sm jf-btn--danger" onClick={remove}>{t("builder.recovery.remove")}</button>
      )}
      {reason === "unavailable" && <p className="jf-field__hint">{t("builder.recovery.keptHint")}</p>}
    </section>
  );
}
