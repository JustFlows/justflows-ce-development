// SPDX-License-Identifier: MIT
import { useT } from "../../i18n/I18nProvider";
import type { SiteContextData, SiteRegion } from "../../lib/site-context";
import { sourceKey } from "./SiteContextFrame";
/** Builder-only styles load with the builder, not on every admin page (justflows-ce#310). */
import "../../styles/builder.css";

/**
 * The Site tab of a page: what surrounds this page and where each part comes
 * from (justflows-ce#303), with the step into editing it. The template's
 * hierarchy is listed so the match is never a mystery.
 */
export default function SiteContextPanel({
  context,
  onEnter,
}: {
  context: SiteContextData | null;
  onEnter: (region: SiteRegion, slug?: string | null) => void;
}) {
  const { t } = useT();
  if (!context) return <p className="jf-field__hint">{t("builder.siteContext.loading")}</p>;
  const template = context.template;
  const row = (region: SiteRegion, label: string, source: SiteContextData["footer"]["source"], slug?: string | null) => (
    <li className="jf-site-panel__row">
      <div>
        <strong>{label}</strong>
        <div className="jf-field__hint" style={{ margin: 0 }}>
          {t(sourceKey(source))} · {t("builder.siteContext.siteWide")}
        </div>
      </div>
      <button type="button" className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => onEnter(region, slug)}>
        {t("builder.presets.edit")}
      </button>
    </li>
  );
  return (
    <nav aria-label={t("builder.siteContext.panelTitle")}>
      <p className="jf-site-nav__heading">{t("builder.siteContext.panelTitle")}</p>
      <p className="jf-field__hint">{t("builder.siteContext.panelHint")}</p>
      <ul className="jf-site-panel">
        {row("header", t("builder.siteContext.region.header"), context.header.source)}
        {template
          ? row("template", t("builder.siteContext.templateNamed", { slug: template.slug }), template.source, template.slug)
          : (
              <li className="jf-site-panel__row">
                <div>
                  <strong>{t("builder.siteContext.region.template")}</strong>
                  <div className="jf-field__hint" style={{ margin: 0 }}>{t("builder.siteContext.noTemplate")}</div>
                </div>
              </li>
            )}
        {row("footer", t("builder.siteContext.region.footer"), context.footer.source)}
      </ul>
      {template && template.candidates.length > 0 && (
        <>
          <p className="jf-site-nav__heading">{t("builder.siteContext.hierarchy")}</p>
          <ol className="jf-site-context__hierarchy jf-site-context__hierarchy--panel">
            {template.candidates.map((c) => (
              <li key={c.slug} aria-current={c.slug === template.slug ? "true" : undefined}>
                <code>{c.slug}</code> <span>{t(sourceKey(c.source))}</span>
              </li>
            ))}
          </ol>
          <p className="jf-field__hint">{t("builder.siteContext.hierarchyHint")}</p>
        </>
      )}
    </nav>
  );
}
