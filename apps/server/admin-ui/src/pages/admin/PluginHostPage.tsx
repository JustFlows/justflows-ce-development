import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { usePluginMenu } from "@components/PluginMenuProvider";
import { navLabel, type PluginMenuItem } from "../../config/admin-nav";
import { useT } from "../../i18n/I18nProvider";
import PluginSetupWizard from "./PluginSetupWizard";

/**
 * Host shell for an admin path a plugin contributed (manifest `adminMenu` or
 * the `admin.menu` filter). Dedicated pages (Analytics, Forms) keep their own
 * routes; everything else lands here so a plugin does not need a core App.tsx
 * entry to be reachable.
 *
 * `GET /ext/{id}/setup` is only mounted on that plugin's `setupPath`, and only
 * while first-run setup is incomplete. After that the landing is the overview;
 * store and plugin options stay on `/admin/plugins/{id}/settings`. Nested menu
 * items (for example `/admin/shop/products`) never mount the wizard. When
 * several menu paths could match, the longest path wins so `/admin/shop` does
 * not steal `/admin/shop/products`. A menu item with `contentType` lists every
 * CMS entry of that type from `/api/content`.
 */
export default function PluginHostPage() {
  const { t } = useT();
  const { items, loading } = usePluginMenu();
  const { pathname } = useLocation();

  if (loading) {
    return (
      <div className="jf-page">
        <div className="jf-skeleton" style={{ height: 240 }} />
      </div>
    );
  }

  const item = matchPluginMenuItem(items, pathname);
  if (!item) return <Navigate to="/admin" replace />;

  const heading = pluginHeading(t, item);
  const onSetupPage = Boolean(item.setupPath) && pathname === item.setupPath;
  const siblings = items.filter(
    (entry) => entry.pluginId === item.pluginId && entry.path !== item.path,
  );
  const overview = (
    <PluginOverviewLanding current={item} items={items} heading={heading} />
  );
  const section = (
    <div className="jf-card">
      <div className="jf-empty">
        <span className="jf-empty__title">{heading}</span>
        <p>{t("pluginPage.sectionBody", { section: heading })}</p>
      </div>
    </div>
  );
  const empty = (
    <div className="jf-card">
      <div className="jf-empty">
        <span className="jf-empty__title">{t("pluginPage.emptyTitle")}</span>
        <p>{t("pluginPage.emptyBody")}</p>
      </div>
    </div>
  );

  if (item.contentType && !onSetupPage) {
    return (
      <PluginContentTypeList
        pluginId={item.pluginId}
        contentType={item.contentType}
        heading={heading}
        icon={item.icon}
      />
    );
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{heading}</h1>
          <p className="jf-meta">{item.pluginId}</p>
        </div>
        <Link className="jf-btn jf-btn--ghost" to={`/admin/plugins/${item.pluginId}/settings`}>
          {t("pluginPage.settings")}
        </Link>
      </header>

      {onSetupPage ? (
        <PluginSetupWizard pluginId={item.pluginId} fallback={overview} completeExtra={overview} />
      ) : siblings.length > 0 ? (
        section
      ) : (
        empty
      )}
    </div>
  );
}

export function matchPluginMenuItem(
  items: PluginMenuItem[],
  pathname: string,
): PluginMenuItem | undefined {
  let best: PluginMenuItem | undefined;
  for (const entry of items) {
    if (pathname === entry.path || pathname.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best;
}

function pluginHeading(
  t: (key: string, vars?: Record<string, string | number>) => string,
  item: PluginMenuItem,
): string {
  return navLabel(t, {
    key: item.labelKey ?? `plugin.${item.pluginId}.${item.id}`,
    label: item.label,
    to: item.path,
    icon: item.icon,
  });
}

type ContentListItem = {
  id: string;
  type: string;
  title: string;
  slug: string;
  locale: string;
  status: string;
  updatedAt: string;
  hasWorkingRevision?: boolean;
};

const CONTENT_PAGE_SIZE = 100;

async function loadAllContentOfType(type: string): Promise<ContentListItem[]> {
  const items: ContentListItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({ type, limit: String(CONTENT_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`/api/content?${params.toString()}`);
    if (!res.ok) throw new Error(`content ${res.status}`);
    const data = (await res.json()) as { items?: unknown; nextCursor?: string | null };
    if (Array.isArray(data.items)) {
      for (const raw of data.items) {
        const item = asContentListItem(raw);
        if (item) items.push(item);
      }
    }
    const next = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : undefined;
    if (!next) break;
    cursor = next;
  }
  return items;
}

function asContentListItem(raw: unknown): ContentListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.title !== "string") return null;
  return {
    id: item.id,
    type: typeof item.type === "string" ? item.type : "",
    title: item.title,
    slug: typeof item.slug === "string" ? item.slug : "",
    locale: typeof item.locale === "string" ? item.locale : "",
    status: typeof item.status === "string" ? item.status : "",
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    hasWorkingRevision: item.hasWorkingRevision === true,
  };
}

function PluginContentTypeList({
  pluginId,
  contentType,
  heading,
  icon,
}: {
  pluginId: string;
  contentType: string;
  heading: string;
  icon: string;
}) {
  const { t } = useT();
  const [items, setItems] = useState<ContentListItem[]>([]);
  const [typeLabel, setTypeLabel] = useState(contentType);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const [rows, typesRes] = await Promise.all([
          loadAllContentOfType(contentType),
          fetch("/api/content-types").then((res) => (res.ok ? res.json() : { types: [] })),
        ]);
        if (cancelled) return;
        setItems(rows);
        const types = Array.isArray((typesRes as { types?: unknown }).types)
          ? ((typesRes as { types: Array<{ slug?: string; label?: string }> }).types)
          : [];
        const match = types.find((entry) => entry.slug === contentType);
        if (typeof match?.label === "string" && match.label.trim()) {
          setTypeLabel(match.label);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentType]);

  const newHref = `/admin/content/new?type=${encodeURIComponent(contentType)}`;

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{heading}</h1>
          <p className="jf-meta">{pluginId}</p>
        </div>
        <div className="jf-pagehead__actions">
          <Link className="jf-btn jf-btn--ghost" to={`/admin/plugins/${pluginId}/settings`}>
            {t("pluginPage.settings")}
          </Link>
          <Link className="jf-btn jf-btn--primary" to={newHref}>
            {t("pluginPage.newType", { type: typeLabel.toLowerCase() })}
          </Link>
        </div>
      </header>

      <div className="jf-card">
        {loading ? (
          <div className="jf-skeleton" style={{ height: 180 }} />
        ) : error ? (
          <div className="jf-empty">
            <span className="jf-empty__title">{t("pluginPage.listError", { section: heading })}</span>
          </div>
        ) : items.length === 0 ? (
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">
              {icon}
            </span>
            <span className="jf-empty__title">{t("pluginPage.listEmptyTitle", { section: heading })}</span>
            <p>{t("pluginPage.listEmptyBody", { type: typeLabel.toLowerCase() })}</p>
          </div>
        ) : (
          <div className="jf-tablewrap">
            <table className="jf-table">
              <thead>
                <tr>
                  <th>{t("content.title")}</th>
                  <th>{t("content.locale")}</th>
                  <th>{t("pluginPage.status")}</th>
                  <th>{t("content.slug")}</th>
                  <th>{t("pluginPage.updated")}</th>
                  <th>
                    <span className="jf-sr-only">{t("pluginPage.edit")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="jf-td--strong">
                      <Link to={`/admin/content/${item.id}`}>{item.title}</Link>
                    </td>
                    <td className="jf-td--mono">{item.locale || "—"}</td>
                    <td>
                      <ContentStatusBadge status={item.status} hasWorkingRevision={item.hasWorkingRevision} />
                    </td>
                    <td className="jf-td--mono">/{item.slug}</td>
                    <td className="jf-td--muted">
                      {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="jf-td--actions">
                      <Link to={`/admin/content/${item.id}`} className="jf-btn jf-btn--quiet">
                        {t("pluginPage.edit")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ContentStatusBadge({
  status,
  hasWorkingRevision,
}: {
  status: string;
  hasWorkingRevision?: boolean;
}) {
  const { t } = useT();
  if (status === "published" && hasWorkingRevision) {
    return <span className="jf-badge jf-badge--info">{t("content.publishedWithDraft")}</span>;
  }
  const variant: Record<string, string> = {
    published: " jf-badge--published",
    archived: " jf-badge--archived",
    scheduled: " jf-badge--info",
  };
  return <span className={`jf-badge${variant[status] ?? ""}`}>{status}</span>;
}

function PluginOverviewLanding({
  current,
  items,
  heading,
}: {
  current: PluginMenuItem;
  items: PluginMenuItem[];
  heading: string;
}) {
  const { t } = useT();
  const pages = items.filter(
    (entry) => entry.pluginId === current.pluginId && entry.path !== current.path,
  );
  if (pages.length === 0) {
    return (
      <div className="jf-card">
        <div className="jf-empty">
          <span className="jf-empty__title">{t("pluginPage.emptyTitle")}</span>
          <p>{t("pluginPage.emptyBody")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="jf-stack">
      <p className="jf-meta">{t("pluginPage.pagesBody", { plugin: heading })}</p>
      <div className="jf-tiles">
        {pages.map((page) => (
          <Link key={page.path} to={page.path} className="jf-tile">
            <span className="jf-tile__icon" aria-hidden="true">
              {page.icon}
            </span>
            <div className="jf-tile__label">{pluginHeading(t, page)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
