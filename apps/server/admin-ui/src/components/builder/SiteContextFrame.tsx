// SPDX-License-Identifier: MIT
import { useEffect, useId, useState, type ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider";
import type { ContextSource, SiteContextData, SiteRegion, TemplateCandidate } from "../../lib/site-context";
import { BlockPreview } from "./BlockPreview";
import type { BlockNode } from "./types";

/**
 * The page's surroundings on the canvas (justflows-ce#303): its header, the
 * template it renders through, and the footer, drawn around the editable
 * content as read-only site context. Each region says where it comes from
 * and that it is site-wide; editing it is a deliberate step into the theme
 * builder, never a click on the page.
 *
 * Dynamic blocks show honest stand-ins: the page's own title and date are
 * real, everything else that depends on the request shows sample text. The
 * published page stays the authority.
 */

export interface SiteContextMeta {
  title: string;
  publishedAt?: string | null;
}

interface SiteContextFrameProps {
  context: SiteContextData;
  meta: SiteContextMeta;
  /** The editable page content. */
  children: ReactNode;
  /** Step into editing a region in the theme builder. */
  onEnter: (region: SiteRegion, slug?: string | null) => void;
}

/** Translation key for a source label. */
export function sourceKey(source: ContextSource): string {
  return `builder.siteContext.source.${source ?? "none"}`;
}

export default function SiteContextFrame({ context, meta, children, onEnter }: SiteContextFrameProps) {
  const { t } = useT();
  const [identity, setIdentity] = useState<{ siteTitle: string; logoUrl: string } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/site/identity")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { siteTitle?: string; logoUrl?: string } | null) => {
        if (alive && data) setIdentity({ siteTitle: data.siteTitle ?? "", logoUrl: data.logoUrl ?? "" });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const date = meta.publishedAt ? new Date(meta.publishedAt).toLocaleDateString() : t("builder.siteContext.notPublished");
  let contentPlaced = false;

  /** Read-only preview of context blocks; the page's own slots get real values. */
  const renderContext = (blocks: BlockNode[], depth: number): ReactNode =>
    blocks.map((block) => {
      switch (block.type) {
        case "core.post-content":
          if (contentPlaced) return <BlockPreview key={block.id} block={block} depth={depth} />;
          contentPlaced = true;
          return (
            <div key={block.id} data-site-context="content" className="jf-site-context__content">
              {children}
            </div>
          );
        case "core.post-title": {
          const level = Math.min(6, Math.max(1, Number(block.props.level) || 1));
          const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
          return (
            <Tag key={block.id} className="post-title" data-jf-sample="title">
              {meta.title || t("pageBuilderPage.untitledPage")}
            </Tag>
          );
        }
        case "core.post-meta":
          return (
            <p key={block.id} className="post-meta" data-jf-sample="date">
              {date}
            </p>
          );
        case "core.template-part": {
          const slug = String(block.props.slug || "header");
          if (slug === "footer") return <Region key={block.id} region="footer" source={context.footer.source} onEnter={onEnter}>{renderContext(context.footer.blocks, depth + 1)}</Region>;
          return (
            <Region key={block.id} region="header" source={context.header.source} onEnter={onEnter}>
              <HeaderPreview config={context.header.config} identity={identity} render={(b) => renderContext(b, depth + 1)} />
            </Region>
          );
        }
        default:
          return <BlockPreview key={block.id} block={block} depth={depth} renderChildren={renderContext} />;
      }
    });

  const template = context.template;
  const body = template ? renderContext(template.blocks, 0) : null;
  const hasHeaderPart = template?.blocks.some((b) => b.type === "core.template-part" && String(b.props.slug || "header") === "header");
  const hasFooterPart = template?.blocks.some((b) => b.type === "core.template-part" && b.props.slug === "footer");

  return (
    <div className="jf-site-context" data-builder-chrome="true">
      <p className="jf-site-context__note" role="note">
        {t("builder.siteContext.previewNote")}
      </p>
      {!hasHeaderPart && (
        <Region region="header" source={context.header.source} onEnter={onEnter}>
          <HeaderPreview config={context.header.config} identity={identity} render={(b) => renderContext(b, 1)} />
        </Region>
      )}
      {template ? (
        <Region region="template" source={template.source} slug={template.slug} candidates={template.candidates} onEnter={onEnter}>
          {body}
          {!contentPlaced && (
            <div data-site-context="content" className="jf-site-context__content">
              {children}
            </div>
          )}
        </Region>
      ) : (
        <div data-site-context="content" className="jf-site-context__content">
          {children}
        </div>
      )}
      {!hasFooterPart && (
        <Region region="footer" source={context.footer.source} onEnter={onEnter}>
          {context.footer.blocks.length ? renderContext(context.footer.blocks, 1) : <p className="jf-site-context__empty">{t("builder.siteContext.footerEmpty")}</p>}
        </Region>
      )}
    </div>
  );
}

function HeaderPreview({
  config,
  identity,
  render,
}: {
  config: SiteContextData["header"]["config"];
  identity: { siteTitle: string; logoUrl: string } | null;
  render: (blocks: BlockNode[]) => ReactNode;
}) {
  const { t, locale } = useT();
  if (!config.visible) return <p className="jf-site-context__empty">{t("builder.siteContext.headerHidden")}</p>;
  /** A stand-in for the language switcher: the admin's own locale code, not copy. */
  const languageSample = `${locale.slice(0, 2)} ⌄`;
  const layoutClass = config.layout === "logo-center" ? " jf-header-chrome--center" : config.layout === "split" ? " jf-header-chrome--split" : "";
  return (
    <div className={`jf-header-chrome jf-header-chrome--context${layoutClass}`} style={config.background ? { background: config.background } : undefined}>
      <span className="jf-header-chrome__brand">
        {config.showLogo && identity?.logoUrl ? <img src={identity.logoUrl} alt="" className="jf-header-chrome__logo" /> : null}
        {config.showTitle ? <span className="jf-header-chrome__title">{identity?.siteTitle || t("builder.headerChrome.siteTitle")}</span> : null}
      </span>
      <span className="jf-header-chrome__nav">
        {config.menuMode !== "none" && <span className="jf-header-chrome__link" data-jf-sample="menu">{t("builder.siteContext.menu")}</span>}
        {config.showLanguageSwitcher ? <span className="jf-header-chrome__widget">{languageSample}</span> : null}
        {config.showColorScheme ? <span className="jf-header-chrome__widget">◐</span> : null}
        {config.showAuthLinks ? <span className="jf-header-chrome__widget">{t("builder.headerChrome.logIn")}</span> : null}
        {Array.isArray(config.blocks) && config.blocks.length > 0 && <div className="jf-header-chrome__blocks">{render(config.blocks as BlockNode[])}</div>}
      </span>
    </div>
  );
}

/**
 * One site-wide region: a chip naming it and its source, an impact note, and
 * the step into editing. Clicking the region opens the note instead of
 * selecting anything, so a stray click can never change a site-wide part.
 */
export function Region({
  region,
  source,
  slug,
  candidates,
  onEnter,
  children,
}: {
  region: SiteRegion;
  source: ContextSource;
  slug?: string | null;
  candidates?: TemplateCandidate[];
  onEnter: (region: SiteRegion, slug?: string | null) => void;
  children: ReactNode;
}) {
  const { t } = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const name = region === "template" && slug ? t("builder.siteContext.templateNamed", { slug }) : t(`builder.siteContext.region.${region}`);
  return (
    <section
      className={`jf-site-context__region jf-site-context__region--${region}${open ? " is-open" : ""}`}
      data-site-context={region}
      aria-labelledby={`${id}-chip`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-site-context='content']")) return;
        e.stopPropagation();
        setOpen(true);
      }}
    >
      <div className="jf-site-context__bar">
        <button id={`${id}-chip`} type="button" className="jf-site-context__chip" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          <span aria-hidden="true">⊞</span> {name}
          <span className="jf-site-context__source">· {t(sourceKey(source))}</span>
          <span className="jf-site-context__badge">{t("builder.siteContext.siteWide")}</span>
        </button>
        {open && (
          <div className="jf-site-context__notice" role="note">
            <p>{t(`builder.shell.impact.${region}`)}</p>
            {region === "template" && candidates && candidates.length > 0 && (
              <ol className="jf-site-context__hierarchy" aria-label={t("builder.siteContext.hierarchy")}>
                {candidates.map((c) => (
                  <li key={c.slug} aria-current={c.slug === slug ? "true" : undefined}>
                    <code>{c.slug}</code> <span>{t(sourceKey(c.source))}</span>
                  </li>
                ))}
              </ol>
            )}
            <button type="button" className="jf-btn jf-btn--primary jf-btn--sm" onClick={(e) => { e.stopPropagation(); onEnter(region, slug); }}>
              {t(`builder.siteContext.edit.${region}`)}
            </button>
          </div>
        )}
      </div>
      <div className="jf-site-context__body" aria-hidden={region === "template" ? undefined : true}>
        {children}
      </div>
    </section>
  );
}
