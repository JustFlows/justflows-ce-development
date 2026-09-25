import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Link, Navigate, useNavigate } from "../../../admin-router";
import { usePluginMenu } from "@components/PluginMenuProvider";
import { navLabel, type PluginMenuItem } from "../../../config/admin-nav";
import { internalAdminPath, publicAdminPath } from "../../../admin-path";
import { useT } from "../../../i18n/I18nProvider";
import PluginSetupWizard from "./PluginSetupWizard";
import { catalogRowsForDefaultLanguage } from "../../../lib/translation-groups";

/**
 * Host shell for an admin path a plugin contributed (manifest `adminMenu` or
 * the `admin.menu` filter). Every plugin page lives under `/admin/plugins/{id}`.
 * Host-rendered pages (Analytics, Cookie Consent) keep their own App.tsx routes;
 * everything else lands here so a plugin does not need a core entry to be
 * reachable.
 *
 * `GET /ext/{id}/setup` is only mounted on that plugin's `setupPath`, and only
 * while first-run setup is incomplete. After that the landing is the overview;
 * store and plugin options stay on `/admin/plugins/{id}/settings`. Nested menu
 * items (for example `/admin/plugins/acme.forms/entries`) never mount the
 * wizard. When several menu paths could match, the longest path wins so
 * `/admin/plugins/acme.forms` does not steal `.../forms/entries`. A menu
 * item with `contentType` lists CMS entries of that type from `/api/content`,
 * one row per translation group in the site's default language. Other
 * languages stay on the content editor.
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

  // A plugin that ships its own admin app owns the whole screen: the host
  // frames the plugin's HTML and only relays navigation / height over
  // postMessage. No core page, no shared React runtime.
  if (item.adminAppUrl) {
    return <PluginFrame key={item.path} item={item} heading={heading} />;
  }
  const onSetupPage = Boolean(item.setupPath) && internalAdminPath(pathname) === item.setupPath;
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
        importPath={items.find((entry) => entry.path === `${item.path}/import`)?.path}
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

/** Message envelope the plugin admin frame and the host exchange. */
const PLUGIN_MSG = "justflows-admin-plugin";
const HOST_MSG = "justflows-admin-host";
const FRAME_MIN_HEIGHT = 240;
const FRAME_MAX_HEIGHT = 20000;

/**
 * Host shell for a plugin that ships its own admin app (`manifest.adminApp`).
 * The plugin's HTML runs in a same-origin `<iframe>`; the two sides talk only
 * through `postMessage` (`@justflows/admin-bridge` on the plugin side):
 *
 * - plugin → host: `ready`, `resize {height}`, `navigate {path}`
 * - host → plugin: `context {locale, adminBase, routePath, theme}`,
 *   `route {routePath}` whenever the host URL changes under the plugin's path
 *
 * The plugin reads the CSRF cookie itself (same origin) and calls its own
 * `ctx.http` routes for data — nothing is proxied through core.
 */
function PluginFrame({ item, heading }: { item: PluginMenuItem; heading: string }) {
  const { t, locale } = useT();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(FRAME_MIN_HEIGHT);
  const [loaded, setLoaded] = useState(false);

  const routePath = internalAdminPath(pathname);

  const post = useCallback((message: Record<string, unknown>) => {
    const win = frameRef.current?.contentWindow;
    if (win) win.postMessage({ source: HOST_MSG, ...message }, window.location.origin);
  }, []);

  const sendContext = useCallback(() => {
    const theme = document.documentElement.dataset.theme ?? "";
    post({
      type: "context",
      context: {
        locale,
        adminBase: internalAdminPath("/admin"),
        routePath,
        theme,
        ...(item.adminCatalogs ? { catalogs: item.adminCatalogs } : {}),
      },
    });
  }, [post, locale, routePath, item.adminCatalogs]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; [k: string]: unknown };
      if (!data || data.source !== PLUGIN_MSG) return;

      switch (data.type) {
        case "ready":
          sendContext();
          break;
        case "resize": {
          const h = Number(data.height);
          if (Number.isFinite(h)) {
            setHeight(Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(h))));
          }
          break;
        }
        case "navigate": {
          const to = String(data.path ?? "");
          if (/^\/admin(\/|$)/.test(to) && !to.includes("..")) {
            navigate(publicAdminPath(to));
          } else if (/^https?:\/\//.test(to)) {
            window.open(to, "_blank", "noopener");
          }
          break;
        }
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate, sendContext]);

  // Host-driven navigation under the plugin's own path subtree: tell the frame
  // so its internal router can follow without a full reload.
  useEffect(() => {
    if (loaded) post({ type: "route", routePath });
  }, [routePath, loaded, post]);

  return (
    <div className="jf-page jf-page--flush">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{heading}</h1>
          <p className="jf-meta">{item.pluginId}</p>
        </div>
        <Link className="jf-btn jf-btn--ghost" to={`/admin/plugins/${item.pluginId}/settings`}>
          {t("pluginPage.settings")}
        </Link>
      </header>
      <iframe
        ref={frameRef}
        src={item.adminAppUrl}
        title={heading}
        className="jf-plugin-frame"
        style={{ height }}
        onLoad={() => {
          setLoaded(true);
          sendContext();
        }}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads allow-modals"
      />
    </div>
  );
}

export function matchPluginMenuItem(
  items: PluginMenuItem[],
  pathname: string,
): PluginMenuItem | undefined {
  // Menu items store canonical `/admin/…` paths; the live pathname may carry a
  // configured admin URL. Compare on the internal form.
  const internal = internalAdminPath(pathname);
  let best: PluginMenuItem | undefined;
  for (const entry of items) {
    if (internal === entry.path || internal.startsWith(`${entry.path}/`)) {
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
  translationGroupId: string;
  status: string;
  updatedAt: string;
  hasWorkingRevision?: boolean;
};

function defaultLocaleFrom(body: unknown): string {
  const languages = (body as { languages?: Array<{ code?: string; isDefault?: boolean }> } | null)
    ?.languages;
  if (!Array.isArray(languages)) return "en-US";
  const marked = languages.find((lang) => lang.isDefault && typeof lang.code === "string");
  if (marked?.code) return marked.code;
  const first = languages.find((lang) => typeof lang.code === "string");
  return first?.code ?? "en-US";
}

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
    translationGroupId:
      typeof item.translationGroupId === "string" && item.translationGroupId
        ? item.translationGroupId
        : item.id,
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
  importPath,
}: {
  pluginId: string;
  contentType: string;
  heading: string;
  icon: string;
  importPath?: string;
}) {
  const { t } = useT();
  const [items, setItems] = useState<ContentListItem[]>([]);
  const [typeLabel, setTypeLabel] = useState(contentType);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setSelected(new Set());
    void (async () => {
      try {
        const [rows, typesRes, langRes] = await Promise.all([
          loadAllContentOfType(contentType),
          fetch("/api/content-types").then((res) => (res.ok ? res.json() : { types: [] })),
          fetch("/api/languages/active")
            .then((res) => (res.ok ? res.json() : { languages: [] }))
            .catch(() => ({ languages: [] })),
        ]);
        if (cancelled) return;
        setItems(catalogRowsForDefaultLanguage(rows, defaultLocaleFrom(langRes)));
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
  }, [contentType, reloadKey]);

  const newHref = `/admin/content/new?type=${encodeURIComponent(contentType)}`;
  const allSelected = items.length > 0 && selected.size === items.length;

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  }

  function toggleOne(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected(): Promise<void> {
    if (selected.size === 0 || deleting) return;
    if (!window.confirm(t("pluginPage.trashConfirm", { count: selected.size }))) return;
    setDeleting(true);
    try {
      for (const id of selected) {
        const res = await fetch(`/api/content/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`delete ${res.status}`);
      }
      setReloadKey((key) => key + 1);
    } catch {
      setError(true);
    } finally {
      setDeleting(false);
    }
  }

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
          {importPath ? (
            <Link className="jf-btn jf-btn--ghost" to={importPath}>
              {t("pluginPage.import")}
            </Link>
          ) : null}
          {selected.size > 0 ? (
            <button type="button" className="jf-btn jf-btn--danger" disabled={deleting} onClick={() => void deleteSelected()}>
              {t("pluginPage.deleteSelected", { count: selected.size })}
            </button>
          ) : null}
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
                  <th>
                    <input
                      type="checkbox"
                      aria-label={t("pluginPage.selectAll")}
                      checked={allSelected}
                      onChange={toggleAll}
                    />
                  </th>
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
                    <td>
                      <input
                        type="checkbox"
                        aria-label={item.title}
                        checked={selected.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                      />
                    </td>
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
    (entry) => entry.pluginId === current.pluginId && entry.path !== current.path && entry.listed !== false,
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
