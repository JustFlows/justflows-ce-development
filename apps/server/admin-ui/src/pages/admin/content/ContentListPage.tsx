import ContentAgenda from "../../../components/ContentAgenda";
import { useT } from "../../../i18n/I18nProvider";
import { useEffect, useState } from "react";
import { Link } from "../../../admin-router";
import { initialJson } from "../../../ssr-data";
import { catalogRowsForDefaultLanguage, translationGroupKey } from "../../../lib/translation-groups";

interface ContentItem {
  id: string;
  type: string;
  title: string;
  slug: string;
  locale: string;
  translationGroupId?: string | null;
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

const STATUS_FILTER_LABEL_KEYS: Record<(typeof STATUS_FILTERS)[number], string> = {
  all: "content.list.statusAll",
  draft: "content.list.statusDraft",
  published: "content.list.statusPublished",
  scheduled: "content.list.statusScheduled",
};

export default function ContentPage() {
  const { t } = useT();
  // Admin content list always spans every language, regardless of the
  // site's default published language — that setting governs public
  // rendering, not what admins can see and manage here.
  const prefetchedLanguages = initialJson<{ languages?: Array<{ code: string; isDefault?: boolean }> }>(
    "/api/languages",
  );
  const prefetchedContent = initialJson<{ items?: ContentItem[] }>("/api/content");
  const prefetchedTypes = initialJson<{ types?: ContentTypeSummary[] }>("/api/content-types");
  const prefetchedSettings = initialJson<{
    home_page_id?: string | null;
    blog_page_id?: string | null;
  }>("/api/settings");
  const [items, setItems] = useState<ContentItem[]>(prefetchedContent?.items ?? []);
  const [languages, setLanguages] = useState<Array<{ code: string; isDefault?: boolean }>>(
    prefetchedLanguages?.languages ?? [],
  );
  const [types, setTypes] = useState<ContentTypeSummary[]>(prefetchedTypes?.types ?? []);
  const [homePageId, setHomePageId] = useState<string | null>(
    prefetchedSettings?.home_page_id ?? null,
  );
  const [blogPageId, setBlogPageId] = useState<string | null>(
    prefetchedSettings?.blog_page_id ?? null,
  );
  const [agenda, setAgenda] = useState(false);
  const [filter, setFilter] = useState("all");
  const [localeFilter, setLocaleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");

  useEffect(() => {
    fetch("/api/content")
      .then((r) => r.json())
      .then((data: { items?: ContentItem[] }) => {
        if (Array.isArray(data.items)) setItems(data.items);
      })
      .catch(() => {
        /* keep prefetched or empty */
      });
    fetch("/api/languages")
      .then((r) => r.json())
      .then((data: { languages?: Array<{ code: string; isDefault?: boolean }> }) => {
        if (Array.isArray(data.languages)) setLanguages(data.languages);
      })
      .catch(() => {});
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
  }, []);

  const [query, setQuery] = useState("");
  const [searchItems, setSearchItems] = useState<ContentItem[]>([]);
  const [searchPage, setSearchPage] = useState(1);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  useEffect(() => { setSearchPage(1); }, [query, filter, localeFilter, statusFilter]);
  useEffect(() => {
    if (!query.trim()) { setSearchItems([]); setSearchBusy(false); setSearchError(""); return; }
    const controller = new AbortController();
    setSearchBusy(true); setSearchError(""); setSearchItems([]);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, page: String(searchPage), limit: "20" });
      if (localeFilter !== "all") params.set("locale", localeFilter);
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
  }, [query, filter, localeFilter, statusFilter, searchPage, t]);

  // Translations are managed from the editor, so "All languages" lists each
  // translation group once (default-language entry first). A specific
  // language chip still shows every entry in that language.
  const defaultLocale =
    languages.find((l) => l.isDefault)?.code ?? languages[0]?.code ?? "en-US";
  const groupItems = new Map<string, ContentItem[]>();
  for (const item of items) {
    const key = translationGroupKey(item);
    groupItems.set(key, [...(groupItems.get(key) ?? []), item]);
  }
  const translationsOf = (item: ContentItem) =>
    groupItems.get(translationGroupKey(item)) ?? [item];
  const rows = localeFilter === "all" ? catalogRowsForDefaultLanguage(items, defaultLocale) : items;

  const filtered = query.trim() ? searchItems : rows.filter(
    (i) =>
      (filter === "all" || i.type === filter) &&
      (localeFilter === "all" || i.locale === localeFilter) &&
      (statusFilter === "all" || (statusFilter === "scheduled" ? Boolean(i.publishOn || i.unpublishOn) : i.status === statusFilter)),
  );

  const typeLabel = (slug: string) => types.find((t) => t.slug === slug)?.label ?? slug;
  const primaryType = types.find((t) => t.slug === "post") ?? types[0];

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("content.list.heading")}</h1>
          <p>{t("content.list.subtitle")}</p>
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
                {t("content.list.newItem", { label: type.label.toLowerCase() })}
              </Link>
            ))}
          {primaryType && (
            <Link
              to={`/admin/content/new?type=${encodeURIComponent(primaryType.slug)}`}
              className="jf-btn jf-btn--primary"
            >
              {t("content.list.newItem", { label: primaryType.label.toLowerCase() })}
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
        {["all", ...types.map((type) => type.slug)].map((typeSlug) => (
          <button
            key={typeSlug}
            className="jf-chip"
            aria-pressed={filter === typeSlug}
            onClick={() => setFilter(typeSlug)}
          >
            {typeSlug === "all" ? t("content.list.allTypes") : typeLabel(typeSlug)}
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
            {t(STATUS_FILTER_LABEL_KEYS[s])}
          </button>
        ))}
        {languages.length > 1 && (
          <>
            <span className="jf-filterbar__sep" aria-hidden="true" />
            {["all", ...languages.map((l) => l.code)].map((code) => (
              <button
                key={code}
                className="jf-chip"
                aria-pressed={localeFilter === code}
                onClick={() => setLocaleFilter(code)}
              >
                {code === "all" ? t("content.list.allLanguages") : code}
              </button>
            ))}
          </>
        )}
        <span className="jf-meta" style={{ marginInlineStart: "auto" }}>
          {t("content.list.filteredCount", {
            count: filtered.length,
            total: query.trim() ? searchTotal : rows.length,
          })}
        </span>
      </div>

      {agenda || statusFilter === "scheduled" ? <ContentAgenda type={filter} locale={null} /> : <div className="jf-card">
        {query.trim() && (searchBusy || searchError) ? null : filtered.length === 0 ? (
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">
              📝
            </span>
            <span className="jf-empty__title">
              {query.trim() ? t("search.empty") : t("content.list.emptyTitle")}
            </span>
            <p>
              {items.length === 0
                ? t("content.list.emptyCreateFirst")
                : t("content.list.emptyNoMatches")}
            </p>
          </div>
        ) : (
          <div className="jf-tablewrap">
            <table className="jf-table">
              <thead>
                <tr>
                  <th>{t("content.list.colTitle")}</th>
                  <th>{t("content.list.colType")}</th>
                  <th>{t("content.list.colLanguage")}</th>
                  <th>{t("content.list.colStatus")}</th>
                  <th>{t("content.list.colSlug")}</th>
                  <th>{t("content.list.colUpdated")}</th>
                  <th>
                    <span className="jf-sr-only">{t("common.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td className="jf-td--strong">
                      <Link to={`/admin/content/${item.id}`}>{item.title}</Link>
                      {translationsOf(item).some((entry) => entry.id === homePageId) ? (
                        <span
                          className="jf-badge jf-badge--published"
                          style={{ marginInlineStart: "0.5rem" }}
                        >
                          {t("content.list.homeBadge")}
                        </span>
                      ) : null}
                      {translationsOf(item).some((entry) => entry.id === blogPageId) ? (
                        <span
                          className="jf-badge jf-badge--published"
                          style={{ marginInlineStart: "0.5rem" }}
                        >
                          {t("content.list.blogBadge")}
                        </span>
                      ) : null}
                    </td>
                    <td>{typeLabel(item.type)}</td>
                    <td className="jf-td--mono">
                      {item.locale ?? "—"}
                      {localeFilter === "all" && !query.trim()
                        ? translationsOf(item)
                            .filter((entry) => entry.id !== item.id)
                            .map((entry) => (
                              <span key={entry.id} className="jf-td--muted">
                                {" "}+{entry.locale}
                              </span>
                            ))
                        : null}
                    </td>
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
                        {t("content.list.edit")}
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
  const { t } = useT();
  if (status === "published" && hasWorkingRevision) {
    return <span className="jf-badge jf-badge--info">{t("content.list.publishedDraftBadge")}</span>;
  }
  const variant: Record<string, string> = {
    published: " jf-badge--published",
    archived: " jf-badge--archived",
    scheduled: " jf-badge--info",
  };
  return <span className={`jf-badge${variant[status] ?? ""}`}>{status}</span>;
}
