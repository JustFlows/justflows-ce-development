import { lazy, Suspense, useState } from "react";
import { useT } from "../../i18n/I18nProvider";

/** Loaded only when a region switches to custom blocks, so the Menus page does not ship the builder. */
const PageBuilder = lazy(() => import("../builder/PageBuilder"));
import type { MegaMenuRegion } from "./menu-tree";
import {
  detectRegionMode,
  linkListItems,
  promoContent,
  withLinkListItems,
  withPromoContent,
  type LinkListEntry,
  type PromoContent,
} from "./mega-region";

/** Must stay in sync with `MEGA_MENU_SAFE_BLOCK_KINDS` in `apps/server/src/lib/navigation/menus-db.ts`
 * (and `packages/sdk/src/hooks.ts`) — this only narrows what the advanced editor offers to
 * insert; the server re-validates and strips anything outside this set regardless. */
const MEGA_MENU_SAFE_BLOCK_KINDS = [
  "core.paragraph",
  "core.heading",
  "core.image",
  "core.button",
  "core.link-list",
  "core.divider",
  "core.spacer",
  "core.section",
  "core.container",
  "core.group",
  "core.columns",
  "core.column",
  "core.grid",
  "core.reusable",
];

interface MegaRegionEditorProps {
  region: MegaMenuRegion;
  onChange: (region: MegaMenuRegion) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

/**
 * One mega-menu column. Almost every real column is one of two shapes — a
 * list of links, or a highlighted promo panel — so this shows a plain form
 * for those, not a block editor. "Advanced" drops down to the full builder
 * for anything else, without losing whatever the form already built.
 */
export default function MegaRegionEditor({
  region,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp = false,
  canMoveDown = false,
}: MegaRegionEditorProps) {
  const { t } = useT();
  const [forceCustom, setForceCustom] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const mode = forceCustom ? "custom" : detectRegionMode(region);

  const summary =
    mode === "links"
      ? t("menus.mega.summaryLinks", { count: linkListItems(region).length })
      : mode === "promo"
        ? t("menus.mega.summaryPromo")
        : t("menus.mega.summaryCustom");

  return (
    <div className="jf-card">
      <div className="jf-card__body jf-stack jf-stack--sm">
        <div className="jf-row" style={{ alignItems: "center" }}>
          <button
            type="button"
            className="jf-iconbtn"
            title={collapsed ? t("menus.expand") : t("menus.collapse")}
            aria-label={collapsed ? t("menus.expand") : t("menus.collapse")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          {(onMoveUp || onMoveDown) && (
            <>
              <button
                type="button"
                className="jf-iconbtn"
                title={t("menus.moveUp")}
                aria-label={t("menus.moveUp")}
                disabled={!canMoveUp}
                onClick={onMoveUp}
              >
                ↑
              </button>
              <button
                type="button"
                className="jf-iconbtn"
                title={t("menus.moveDown")}
                aria-label={t("menus.moveDown")}
                disabled={!canMoveDown}
                onClick={onMoveDown}
              >
                ↓
              </button>
            </>
          )}
          <input
            className="jf-input"
            style={{ flex: 1 }}
            placeholder={t("menus.mega.heading")}
            value={region.heading ?? ""}
            onChange={(e) => onChange({ ...region, heading: e.target.value || undefined })}
          />
          <label className="jf-field" style={{ width: 90 }}>
            <span className="jf-field__label">{t("menus.mega.span")}</span>
            <input
              type="number"
              min={1}
              max={6}
              className="jf-input"
              value={region.span ?? 1}
              onChange={(e) => onChange({ ...region, span: Number(e.target.value) || 1 })}
            />
          </label>
          <button
            className="jf-iconbtn jf-iconbtn--danger"
            title={t("common.delete")}
            aria-label={t("common.delete")}
            onClick={onDelete}
          >
            ×
          </button>
        </div>

        {collapsed ? (
          <p className="jf-field__hint">{summary}</p>
        ) : (
          <>
            {mode === "links" && <LinksEditor region={region} onChange={onChange} />}
            {mode === "promo" && <PromoEditor region={region} onChange={onChange} />}
            {mode === "custom" && (
              <div className="jf-field">
                <span className="jf-field__label">{t("menus.mega.content")}</span>
                <p className="jf-field__hint">{t("menus.mega.customHint")}</p>
                <Suspense fallback={<p className="jf-field__hint" role="status">{t("pageBuilderPage.loading")}</p>}>
                  <PageBuilder
                    value={{ version: 1, blocks: region.blocks }}
                    onChange={(doc) => onChange({ ...region, blocks: doc.blocks })}
                    compact
                    flatCanvas
                    allowedBlockTypes={MEGA_MENU_SAFE_BLOCK_KINDS}
                    enableKeyboardShortcut={false}
                  />
                </Suspense>
              </div>
            )}

            {!forceCustom && (
              <button type="button" className="jf-linkbtn" onClick={() => setForceCustom(true)} style={{ alignSelf: "start" }}>
                {t("menus.mega.useAdvanced")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LinksEditor({
  region,
  onChange,
}: {
  region: MegaMenuRegion;
  onChange: (region: MegaMenuRegion) => void;
}) {
  const { t } = useT();
  const items = linkListItems(region);

  function update(next: LinkListEntry[]) {
    onChange(withLinkListItems(region, next));
  }

  return (
    <div className="jf-stack jf-stack--sm">
      {items.map((item, i) => (
        <div className="jf-row" key={i}>
          <input
            className="jf-input"
            style={{ flex: 1 }}
            placeholder={t("menus.mega.linkLabel")}
            value={item.label}
            onChange={(e) => update(items.map((it, ix) => (ix === i ? { ...it, label: e.target.value } : it)))}
          />
          <input
            className="jf-input"
            style={{ flex: 1 }}
            placeholder={t("menus.mega.linkUrl")}
            value={item.url}
            onChange={(e) => update(items.map((it, ix) => (ix === i ? { ...it, url: e.target.value } : it)))}
          />
          <button
            className="jf-iconbtn jf-iconbtn--danger"
            title={t("common.delete")}
            aria-label={t("common.delete")}
            disabled={items.length <= 1}
            onClick={() => update(items.filter((_, ix) => ix !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="jf-btn jf-btn--ghost jf-btn--block" onClick={() => update([...items, { label: "", url: "" }])}>
        {t("menus.mega.addLink")}
      </button>
    </div>
  );
}

function PromoEditor({
  region,
  onChange,
}: {
  region: MegaMenuRegion;
  onChange: (region: MegaMenuRegion) => void;
}) {
  const { t } = useT();
  const content = promoContent(region);

  function update(patch: Partial<PromoContent>) {
    onChange(withPromoContent(region, { ...content, ...patch }));
  }

  return (
    <div className="jf-stack jf-stack--sm">
      <div className="jf-field">
        <label className="jf-field__label" htmlFor={`jf-promo-bg-${region.id}`}>{t("menus.mega.promoBackground")}</label>
        <select
          id={`jf-promo-bg-${region.id}`}
          className="jf-input"
          value={content.background}
          onChange={(e) => update({ background: e.target.value as PromoContent["background"] })}
        >
          <option value="default">{t("menus.mega.promoBgDefault")}</option>
          <option value="muted">{t("menus.mega.promoBgMuted")}</option>
          <option value="primary">{t("menus.mega.promoBgPrimary")}</option>
          <option value="dark">{t("menus.mega.promoBgDark")}</option>
          <option value="gradient">{t("menus.mega.promoBgGradient")}</option>
        </select>
      </div>
      <input
        className="jf-input"
        placeholder={t("menus.mega.promoHeading")}
        value={content.heading}
        onChange={(e) => update({ heading: e.target.value })}
      />
      <textarea
        className="jf-input"
        rows={3}
        placeholder={t("menus.mega.promoBody")}
        value={content.body}
        onChange={(e) => update({ body: e.target.value })}
      />
      <div className="jf-row">
        <input
          className="jf-input"
          style={{ flex: 1 }}
          placeholder={t("menus.mega.promoButtonLabel")}
          value={content.buttonLabel}
          onChange={(e) => update({ buttonLabel: e.target.value })}
        />
        <input
          className="jf-input"
          style={{ flex: 1 }}
          placeholder={t("menus.mega.promoButtonUrl")}
          value={content.buttonUrl}
          onChange={(e) => update({ buttonUrl: e.target.value })}
        />
      </div>
    </div>
  );
}
