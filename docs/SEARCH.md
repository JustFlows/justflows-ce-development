# Site and admin search

Public Roadmap: [#101](https://github.com/JustFlows/justflows-ce/issues/101).

## Use search

- Visit `/search?q=astronomy`, or `/<active-locale>/search?q=astronomy`.
  The unprefixed page uses the site's default locale. Search forms inserted by
  the builder use the current page's locale.
- Add the **Search** block (`core.search`, following the platform's dot-separated
  block IDs) to a page, header, or footer. Its inspector offers a label, content
  type scope, taxonomy/term scope, visible filters, and results per page.
  Scope is a visitor-facing default, not an access-control boundary.
- **Admin → Content** searches the database instead of filtering only the first
  loaded page. Results honor the user's site, ownership, content-type, and locale
  scope. Type/status filters and pagination are sent to the server.
- **Admin → Tools → Site search** controls which content types appear publicly,
  optional anonymous metrics, and **Rebuild search index**. Managing these tools
  requires `settings:manage`. Default public types are `page`, `post`, and
  `product`; enable custom types explicitly. Selecting none disables public
  results. Search visibility does not change a content entry's permalink access.

Public searches only return published, non-trashed rows whose publication time
has arrived. Preview parameters never enable drafts on the search endpoint.
Working revisions cannot replace published text in the index. Admin searches
also find unpublished content, subject to the editor's access policy.

## Query parameters and API

Enable the existing public content API in Settings for headless requests:

```http
GET /api/v1/search?q=astronomy&locale=en-US&type=post&page=1&limit=20
```

The endpoint inherits the public API's enablement, CORS, access, and rate-limit
middleware. Search adds a limit of 60 requests/minute/IP. The HTML search page
works independently of the headless API setting and uses the same limit.
The session-authenticated admin endpoint is `GET /api/search` (120/minute/IP).
Both respond with `Cache-Control: private, no-store`.

| Parameter          | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `q`                | At most 200 characters; up to 12 distinct Unicode word/number tokens  |
| `locale`           | Active content locale for the API; public HTML uses its URL prefix    |
| `type`             | One content type slug                                                 |
| `taxonomy`, `term` | Taxonomy slug and/or term slug; terms are read from current relations |
| `after`, `before`  | Inclusive publication dates in `YYYY-MM-DD` format                    |
| `page`             | 1–100, default 1                                                      |
| `limit`            | 1–50, default 20                                                      |
| `status`           | Admin endpoint only; filters the current content row's status         |

Blank optional form inputs are ignored. Invalid dates, duplicate scalar
parameters, unknown API locales, and out-of-range pagination return 400.
An empty or punctuation-only query returns no matches. Search engine operators
are not passed through: input becomes word prefixes joined with AND.

Responses include `items`, `total`, `page`, `limit`, `hasMore`, `backend`, and
`typoTolerance`. Each item contains its ID, type, locale, title, slug, status,
dates, canonical permalink `url`, excerpt, and `highlights.title` /
`highlights.excerpt`. Highlights are arrays of `{ text, match }` segments,
**not HTML**. Render their text with normal escaping; optionally wrap matches
in `<mark>`. Never put a segment into `innerHTML`.

## Index and lifecycle

Migration `0028_site_search` adds `search_documents`, keyed by content ID with
cascade deletion. PostgreSQL uses a generated weighted `tsvector` and GIN
index. MySQL and MariaDB use InnoDB FULLTEXT indexes. No search service or
additional database extension is required.

Title ranks above slug, summary, and block body. PostgreSQL uses the `simple`
dictionary to avoid applying English stemming to other locales. The default
engines support word-prefix matching, not edit-distance typo correction.
MySQL/MariaDB token-length and stopword settings affect which words are indexed;
CJK segmentation and language-specific stemming need a suitable external engine.
Highlighting marks literal query text, so an external engine's typo-corrected
match may have no highlighted span.

The body extractor indexes visible text properties (`text`, `content`, `html`,
`heading`, `subheading`, `title`, `description`, `caption`, `quote`,
`buttonLabel`, and nested block/item text). It strips markup through the blocks
sanitizer and bounds text to 100,000 characters. Arbitrary custom fields,
URLs, form defaults, scripts, and working revision data are not indexed.
Dynamic plugin-generated content and referenced reusable-block expansion are
not part of this stored-text index; provide searchable summaries for them.

Content create/update/publish/unpublish/delete hooks update one document after
the content write. Restore and permanent purge also update the index. The
source row is locked while writing its document, so an overlapping rebuild
cannot write an older snapshot. Initial startup backfills missing/stale rows;
a one-minute reconciliation repairs interrupted hook delivery and writes made
outside the normal lifecycle (such as imports).

Rebuild runs in batches of 100 without clearing the existing index. Searches
remain available, with results transitioning as each document is replaced.
Rebuild is idempotent and a repeated request shares the current process's run.
The action is limited to two requests/minute/IP. Large sites should allow an
appropriate reverse-proxy request timeout for the synchronous rebuild response.

Performance targets for a warm local database on a modest 2-vCPU host: search
p95 below 200 ms for 10,000 typical text entries; normal incremental indexing
below one second per entry. These are deployment validation targets, not a
hardware-independent guarantee. Measure with representative content, locale,
stopword settings, and concurrent writes. No leading-wildcard LIKE scan or
per-query index rebuild is used. Use an external engine for larger corpora or
specialized language/typo behavior.

## External backend plugins

`SearchBackend` and `SearchDocument` are public SDK types. A plugin with
`content:read` can supply an engine through `search.backend`:

```ts
import type { PluginContext, SearchBackend } from "@justflows/sdk";

export function attachSearch(ctx: PluginContext, engine: SearchBackend) {
  return ctx.hooks.filter("search.backend", (current) => current ?? engine);
}
```

The canonical example includes
[`search-backend-example.ts`](../plugins/hello-world/src/search-backend-example.ts).
Declare `content:read` before enabling it. Hook registrations are removed on
plugin deactivation, immediately restoring the database backend. Only activate
one search engine per site, or explicitly coordinate filter priorities.

Implement these methods:

- `upsert(document)`: idempotently store `{ id, siteId, locale, type, title,
slug, summary, body }`. Only currently public, search-enabled content is sent.
- `remove(id, siteId)`: idempotently delete a document, including unknown IDs.
- `search({ siteId, q, locale, limit })`: return ranked content IDs, restricted to
  that site and locale, respecting the requested candidate limit. Set
  `typoTolerance: true` only when the engine actually provides it.

Run **Rebuild search index** after attaching or replacing an engine or changing
public type visibility, so the remote corpus is repopulated/pruned. Configure
remote credentials privately in plugin settings. Use network timeouts and
cancellation in the adapter; the host stops waiting after five seconds but
cannot cancel arbitrary plugin code. External indexing failure preserves the local document and marks it for
reconciliation to retry. Startup backfills the local index first and runs any
external backfill in the background, so a plugin outage cannot prevent boot. Failed external searches return a
safe error rather than silently changing the matching rules.

External candidates are capped at 1,000 per request. The host rechecks live
site, publication, locale, type, taxonomy, and date constraints in SQL, computes
authorized totals within that candidate window, and builds URLs/snippets from
its local index. It never trusts remote snippets, URLs, or totals. Broad queries
may therefore be limited to that window. Admin uses the same local index,
including drafts; unpublished data is not exported to external services.
Plugins must clean up their remote index on uninstall and define remote data
retention. Removed IDs can never bypass the host's live-row visibility checks.

## Theme integration

The template hierarchy resolves `templates/search.json`, then `index.json`.
Include `core.post-content` to render the search form, filters, results, and
pagination. The default theme ships an example and styles `.jf-search`,
`.jf-search-page`, `.jf-search-results`, and `.jf-search-pagination` without
requiring a CSS provider. Forms and pagination work without browser JavaScript.
Search pages carry `noindex, follow` and bypass public page caches.
Static exports cannot execute a database search; keep a live origin for search
or use a headless frontend that calls the enabled search API.

## Privacy

Metrics are off by default. Opt-in metrics record only token count, result
count, and duration in the `search_metrics` database table, together with a row ID,
site ID, and creation timestamp. No search metrics are written to console or file logs. They contain no query text or hash,
IP, account ID, referrer, or request correlation ID. This avoids retaining
sensitive terms visitors might type or reversible hashes of low-entropy queries.
Migration `0029_search_metrics` creates this table. Rows are retained until explicitly
deleted (or their site is deleted); disabling metrics stops new writes and preserves
existing rows. Admin searches and empty queries do not create metrics.
Reverse proxies and external engines may have independent logging policies;
configure them before enabling a remote backend. Query and result strings are
escaped at every HTML boundary, and the API returns plain highlight segments.

## Local verification

Run package tests, server/admin type/build checks, and the opt-in native database
suite against a disposable database named `search_test`:

```sh
SEARCH_TEST_DATABASE=1 DB_DRIVER=postgres DB_HOST=127.0.0.1 \
  DB_PORT=5432 DB_NAME=search_test DB_USER=postgres DB_PASSWORD='' \
  pnpm --filter @justflows/server exec vitest run \
  src/lib/__tests__/search-db.integration.test.ts
```

Use `mysql` or `mariadb` and their connection details for the other engines.
The suite creates a minimal source fixture, applies `0028_site_search` and `0029_search_metrics`, and
checks ranking, visibility, pagination, updates/deletes, and remote-candidate
revalidation. It does not modify the installed site's database.
