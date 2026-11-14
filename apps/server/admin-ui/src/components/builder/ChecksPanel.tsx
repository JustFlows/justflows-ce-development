import { useMemo } from "react";
import { checkAccessibility, type AccessibilityIssue, type AccessibilitySeverity } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import type { BlockCatalogEntry, BlockNode } from "./types";
import type { InspectorTab } from "./shell/builder-prefs";

/**
 * Accessibility checks for the document being edited (justflows-ce#307).
 *
 * Lists what `checkAccessibility` finds, grouped as problems, things to
 * review and checks it could not run, and jumps to the block and settings tab
 * that fix each one. It says plainly that these checks help but do not prove
 * a page is accessible.
 */

const ORDER: AccessibilitySeverity[] = ["error", "warning", "unavailable"];

export function useAccessibilityIssues(blocks: BlockNode[], catalog: Map<string, BlockCatalogEntry>): AccessibilityIssue[] {
  return useMemo(
    () => checkAccessibility(blocks, { isOpaqueType: (type) => !type.startsWith("core.") || !catalog.has(type) }),
    [blocks, catalog],
  );
}

export default function ChecksPanel({
  issues,
  catalog,
  onShow,
}: {
  issues: AccessibilityIssue[];
  catalog: Map<string, BlockCatalogEntry>;
  /** Select the block, open the settings tab that fixes the issue, and focus its field. */
  onShow: (blockId: string, tab: InspectorTab, field?: string) => void;
}) {
  const { t } = useT();
  const groups = ORDER.map((severity) => ({ severity, items: issues.filter((issue) => issue.severity === severity) })).filter((g) => g.items.length > 0);

  const message = (issue: AccessibilityIssue): string => {
    const params = Object.fromEntries(Object.entries(issue.params ?? {}).map(([k, v]) => [k, String(v)]));
    switch (issue.code) {
      case "image-alt": return t("builder.checks.imageAlt");
      case "link-text": return issue.params?.item ? t("builder.checks.linkTextItem", { item: params.item ?? "" }) : t("builder.checks.linkText");
      case "link-target": return t("builder.checks.linkTarget");
      case "heading-empty": return t("builder.checks.headingEmpty");
      case "heading-skip": return t("builder.checks.headingSkip", { from: params.from ?? "", to: params.to ?? "" });
      case "heading-level-one": return t("builder.checks.headingLevelOne");
      case "contrast": return t("builder.checks.contrast", { ratio: params.ratio ?? "" });
      case "contrast-unknown": return t("builder.checks.contrastUnknown");
      case "hidden-on-mobile": return t("builder.checks.hiddenOnMobile");
      case "reading-order": return t("builder.checks.readingOrder");
      case "icon-label": return t("builder.checks.iconLabel");
      case "table-header": return t("builder.checks.tableHeader");
      case "content-unchecked": return t("builder.checks.contentUnchecked");
    }
  };

  return (
    <section className="jf-checks" aria-labelledby="jf-checks-title">
      <h2 id="jf-checks-title" className="jf-checks__title">{t("builder.checks.title")}</h2>
      <p className="jf-checks__note">{t("builder.checks.disclaimer")}</p>
      {groups.length === 0 ? (
        <p className="jf-checks__empty" role="status">{t("builder.checks.none")}</p>
      ) : (
        groups.map(({ severity, items }) => (
          <div key={severity} className={`jf-checks__group jf-checks__group--${severity}`}>
            <h3 className="jf-checks__heading">
              {severity === "error" ? t("builder.checks.errors", { count: items.length })
                : severity === "warning" ? t("builder.checks.warnings", { count: items.length })
                : t("builder.checks.unavailable", { count: items.length })}
            </h3>
            <ul className="jf-checks__list">
              {items.map((issue, index) => {
                const title = catalog.get(issue.type)?.title ?? issue.type;
                return (
                  <li key={`${issue.blockId}-${issue.code}-${index}`} className="jf-checks__item" data-severity={issue.severity}>
                    <button type="button" className="jf-checks__show" onClick={() => onShow(issue.blockId, issue.tab, issue.field)}>
                      <span className="jf-checks__block">{title}</span>
                      <span className="jf-checks__message">{message(issue)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * Focus the settings control for `field` once the inspector shows it: the
 * first input, select, textarea or button inside the element marked
 * `data-jf-field`. Tries for a few frames, since selecting a block and
 * switching tabs render first. Returns false when the field never appears.
 */
export function focusInspectorField(field: string, root: () => ParentNode | null = () => document, frames = 12): Promise<boolean> {
  return new Promise((resolve) => {
    let left = frames;
    const attempt = () => {
      const marker = root()?.querySelector(`[data-jf-field="${CSS.escape(field)}"]`);
      const target = marker?.matches("input, select, textarea, button")
        ? (marker as HTMLElement)
        : marker?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button");
      if (target) {
        target.scrollIntoView?.({ block: "center" });
        target.focus();
        resolve(true);
        return;
      }
      if (--left <= 0) {
        resolve(false);
        return;
      }
      requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  });
}
