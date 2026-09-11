import ContentAgenda from "../../components/ContentAgenda";
import { useT } from "../../i18n/I18nProvider";
import { useEffect, useState } from "react";
import { Link } from "../../admin-router";
import { initialJson } from "../../ssr-data";

interface ContentItem {
  id: string;
  type: string;
  title: string;
  slug: string;
  locale: string;
  status: string;
  publishOn?: string | null;
  unpublishOn?: string | null;
  updatedAt: string;
  hasWorkingRevision?: boolean;
}

interface ContentTypeSummary {
  slug: string;
  label: string;
}

const STATUS_FILTERS = ["all", "draft", "published", "scheduled"] as const;

function defaultLocaleCode(
  languages?: Array<{ code: string; isDefault?: boolean }>,
): string | null {
  if (!languages?.length) return null;
  return languages.find((lang) => lang.isDefault)?.code ?? languages[0]?.code ?? null;
}

function contentListPath(locale: string | null): string {
  return locale ? `/api/content?locale=${encodeURIComponent(locale)}` : "/api/content";
}

export default function ContentPage() {
  const { t } = useT();
  const prefetchedLanguages = initialJson<{ languages?: Array<{ code: string; isDefault?: boolean }> }>(
    "/api/languages",
  );
  const defaultLocale = defaultLocaleCode(prefetchedLanguages?.languages);
  const prefetchedContent = initialJson<{ items?: ContentItem[] }>(contentListPath(defaultLocale));
  const prefetchedTypes = initialJson<{ types?: ContentTypeSummary[] }>("/api/content-types");
  const prefetchedSettings = initialJson<{
    home_page_id?: string | null;
    blog_page_id?: string | null;
  }>("/api/settings");
  const [items, setItems] = useState<ContentItem[]>(prefetchedContent?.items ?? []);
  const [types, setTypes] = useState<ContentTypeSummary[]>(prefetchedTypes?.types ?? []);
  const [homePageId, setHomePageId] = useState<string | null>(
    prefetchedSettings?.home_page_id ?? null,
  );
  const [blogPageId, setBlogPageId] = useState<string | null>(
    prefetchedSettings?.blog_page_id ?? null,
  );
  const [agenda, setAgenda] = useState(false);
  const [filter, setFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");

  useEffect(() => {
    async function loadContent() {
      try {
        let locale = defaultLocale;
        if (!locale) {
          const langRes = await fetch("/api/languages");
          const langData = await langRes.json();
          locale = defaultLocaleCode(langData.languages);
        }
        const data = await fetch(contentListPath(locale)).then((r) => r.json());
        if (Array.isArray(data.items)) setItems(data.items);
      } catch {
        /* keep prefetched or empty */
      }
    }
    void loadContent();
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { home_page_id?: string | null; blog_page_id?: string | null }) => {
        setHomePageId(typeof data.home_page_id === "string" ? data.home_page_id : null);
        setBlogPageId(typeof data.blog_page_id === "string" ? data.blog_page_id : null);
      })
      .catch(() => {});
    fetch("/api/content-types")
      .then((r) => r.json())
      .then((data: { types?: ContentTypeSummary[] }) => {
        if (Array.isArray(data.types)) setTypes(data.types);
      })
      .catch(() => {});
  }, [defaultLocale]);

  const [query, setQuery] = useState("");
  const [searchItems, setSearchItems] = useState<ContentItem[]>([]);
  const [searchPage, setSearchPage] = useState(1);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  useEffect(() => { setSearchPage(1); }, [query, filter, statusFilter]);
  useEffect(() => {
    if (!query.trim()) { setSearchItems([]); setSearchBusy(false); setSearchError(""); return; }
    const controller = new AbortController();
    setSearchBusy(true); setSearchError(""); setSearchItems([]);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, page: String(searchPage), limit: "20" });
      if (defaultLocale) params.set("locale", defaultLocale);
      if (filter !== "all") params.set("type", filter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      void fetch(`/api/search?${params}`, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error();
        const result = await response.json();
        if (!controller.signal.aborted) { setSearchItems(result.items); setSearchTotal(result.total); }
      }).catch(() => { if (!controller.signal.aborted) setSearchError(t("search.error")); })
        .finally(() => { if (!controller.signal.aborted) setSearchBusy(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, filter, statusFilter, searchPage, defaultLocale, t]);

  const filtered = query.trim() ? searchItems : items.filter(
    (i) =>
      (filter === "all" || i.type === filter) &&
      (statusFilter === "all" || (statusFilter === "scheduled" ? Boolean(i.publishOn || i.unpublishOn) : i.status === statusFilter)),
  );

  const typeLabel = (slug: string) => types.find((t) => t.slug === slug)?.label ?? slug;
  const primaryType = types.find((t) => t.slug === "post") ?? types[0];

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>Content</h1>
          <p>Posts, pages and custom content types</p>
        </div>
        <div className="jf-pagehead__actions">
          {types
            .filter((t) => t.slug !== (primaryType?.slug ?? "post"))
            .map((type) => (
              <Link
                key={type.slug}
                to={`/admin/content/new?type=${encodeURIComponent(type.slug)}`}
                className="jf-btn jf-btn--ghost"
              >
                + New {type.label.toLowerCase()}
              </Link>
            ))}
          {primaryType && (
            <Link
              to={`/admin/content/new?type=${encodeURIComponent(primaryType.slug)}`}
              className="jf-btn jf-btn--primary"
            >
              + New {primaryType.label.toLowerCase()}
            </Link>
          )}
        </div>
      </header>

      <label className="jf-field" style={{ maxWidth: "22rem" }}>
        <span className="jf-field__label">{t("search.query")}</span>
        <input
          className="jf-input"
          type="search"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {searchBusy && (
        <p className="jf-meta" role="status">
          {t("search.loading")}
        </p>
      )}
      {searchError && (
        <div className="jf-alert jf-alert--error" role="alert">
          {searchError}
        </div>
      )}
      {query.trim() && !searchBusy && !searchError && (
        <nav
          className="jf-row"
          style={{ gap: "0.75rem", justifyContent: "center" }}
          aria-label={t("search.pagination")}
        >
          <button
            className="jf-btn jf-btn--ghost jf-btn--sm"
            disabled={searchPage === 1}
            onClick={() => setSearchPage((p) => p - 1)}
          >
            <span aria-hidden="true">← </span>
            {t("search.previous")}
          </button>
          <span className="jf-meta">
            {searchTotal} {t("search.results")}
          </span>
          <button
            className="jf-btn jf-btn--ghost jf-btn--sm"
            disabled={searchPage * 20 >= searchTotal || searchPage >= 100}
            onClick={() => setSearchPage((p) => p + 1)}
          >
            {t("search.next")}
            <span aria-hidden="true"> →</span>
          </button>
        </nav>
      )}
      <button className="jf-btn jf-btn--secondary" aria-pressed={agenda} onClick={() => setAgenda(value => !value)}>{t("scheduling.agenda")}</button>
      <div className="jf-filterbar">
        {["all", ...types.map((t) => t.slug)].map((t) => (
          <button
            key={t}
            className="jf-chip"
            aria-pressed={filter === t}
            onClick={() => setFilter(t)}
          >
            {t === "all" ? "All" : typeLabel(t)}
          </button>
        ))}
        <span className="jf-filterbar__sep" aria-hidden="true" />
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            className="jf-chip"
            aria-pressed={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          >
            {`${s[0]!.toUpperCase()}${s.slice(1)}`}
          </button>
        ))}
        <span className="jf-meta" style={{ marginInlineStart: "auto" }}>
          {filtered.length} of {query.trim() ? searchTotal : items.length}
        </span>
      </div>

      {agenda || statusFilter === "scheduled" ? <ContentAgenda type={filter} locale={null} /> : <div className="jf-card">
        {query.trim() && (searchBusy || searchError) ? null : filtered.length === 0 ? (
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">
              📝
            </span>
            <span className="jf-empty__title">
              {query.trim() ? t("search.empty") : "Nothing here yet"}
            </span>
            <p>
              {items.length === 0
                ? "Create your first post or page to get started."
                : "No content matches the current filters."}
            </p>
          </div>
        ) : (
          <div className="jf-tablewrap">
            <table className="jf-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Language</th>
                  <th>Status</th>
                  <th>Slug</th>
                  <th>Updated</th>
                  <th>
                    <span className="jf-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td className="jf-td--strong">
                      <Link to={`/admin/content/${item.id}`}>{item.title}</Link>
                      {homePageId === item.id ? (
                        <span
                          className="jf-badge jf-badge--published"
                          style={{ marginInlineStart: "0.5rem" }}
                        >
                          Home
                        </span>
                      ) : null}
                      {blogPageId === item.id ? (
                        <span
                          className="jf-badge jf-badge--published"
                          style={{ marginInlineStart: "0.5rem" }}
                        >
                          Blog
                        </span>
                      ) : null}
                    </td>
                    <td>{typeLabel(item.type)}</td>
                    <td className="jf-td--mono">{item.locale ?? "—"}</td>
                    <td>
                      <StatusBadge status={item.status} hasWorkingRevision={item.hasWorkingRevision} />
                      {(item.publishOn || item.unpublishOn) && <span className="jf-badge">{t("scheduling.title")}</span>}
                    </td>
                    <td className="jf-td--mono">/{item.slug}</td>
                    <td className="jf-td--muted">
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </td>
                    <td className="jf-td--actions">
                      <Link to={`/admin/content/${item.id}`} className="jf-btn jf-btn--quiet">
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>}
    </div>
  );
}

function StatusBadge({ status, hasWorkingRevision }: { status: string; hasWorkingRevision?: boolean }) {
  if (status === "published" && hasWorkingRevision) {
    return <span className="jf-badge jf-badge--info">Published — draft changes</span>;
  }
  const variant: Record<string, string> = {
    published: " jf-badge--published",
    archived: " jf-badge--archived",
    scheduled: " jf-badge--info",
  };
  return <span className={`jf-badge${variant[status] ?? ""}`}>{status}</span>;
}
