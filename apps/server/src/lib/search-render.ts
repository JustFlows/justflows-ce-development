// SPDX-License-Identifier: MIT
import { esc, safeHref } from "@justflows/blocks";
import type { SearchQuery } from "@justflows/content";
import type { searchContent } from "./search-db.js";

export function renderSearchPage(
  query: SearchQuery,
  result: Awaited<ReturnType<typeof searchContent>>,
  action: string,
  t: (key: string) => string,
): string {
  const highlight = (parts: Array<{ text: string; match: boolean }>) =>
    parts.map((p) => (p.match ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join("");
  const input = (name: "type" | "taxonomy" | "term" | "after" | "before", type = "text") =>
    `<label>${esc(t(`search.${name}`))} <input name="${name}" type="${type}" value="${esc(query[name] ?? "")}" maxlength="255"></label>`;
  const pageLink = (page: number, label: string) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...query, page }))
      if (value !== undefined && value !== "") params.set(key, String(value));
    return `<a href="${esc(`${action}?${params}`)}">${esc(label)}</a>`;
  };
  return `<section class="jf-search-page"><h1>${esc(t("search.title"))}</h1>
    <form class="jf-search" role="search" action="${esc(action)}" method="get">
      <label>${esc(t("search.query"))} <input type="search" name="q" maxlength="200" value="${esc(query.q)}" required></label>
      <details><summary>${esc(t("search.filters"))}</summary>${input("type")}${input("taxonomy")}${input("term")}${input("after", "date")}${input("before", "date")}</details>
      <input type="hidden" name="limit" value="${query.limit}"><button type="submit">${esc(t("search.submit"))}</button>
    </form>
    ${!query.q ? `<p>${esc(t("search.prompt"))}</p>` : `<p role="status">${result.total} ${esc(t("search.results"))}</p>`}
    ${query.q && !result.items.length ? `<p>${esc(t("search.empty"))}</p>` : ""}
    <ol class="jf-search-results" start="${(query.page - 1) * query.limit + 1}">${result.items.map((item) => `<li><article><h2><a href="${safeHref(item.url)}">${highlight(item.highlights.title)}</a></h2><p>${highlight(item.highlights.excerpt)}</p><small>${esc(item.type)}</small></article></li>`).join("")}</ol>
    <nav class="jf-search-pagination" aria-label="${esc(t("search.pagination"))}">${query.page > 1 ? pageLink(query.page - 1, t("search.previous")) : ""} ${result.hasMore && query.page < 100 ? pageLink(query.page + 1, t("search.next")) : ""}</nav>
  </section>`;
}
