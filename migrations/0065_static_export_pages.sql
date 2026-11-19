/**
 * On-demand static export (justflows-ce#344). One row per page file that was
 * built on a visit. The app reads these rows to decide whether a file is
 * fresh, so they must be shared by every app process and survive restarts.
 *
 * Times are milliseconds since the epoch. `rendered_at` is when the render
 * started; `marked_at` is the last time a change made the page stale. A row
 * is stale when `marked_at` is later than `rendered_at`, when its
 * `export_version` is not the site's current version, or when it expired.
 */
CREATE TABLE IF NOT EXISTS static_export_pages (
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  path_hash CHAR(64) NOT NULL,
  path VARCHAR(2048) NOT NULL,
  file VARCHAR(2048) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  content_type VARCHAR(200) NOT NULL,
  cache_control VARCHAR(500) NOT NULL,
  bytes BIGINT NOT NULL,
  export_version BIGINT NOT NULL,
  rendered_at BIGINT NOT NULL,
  marked_at BIGINT NOT NULL DEFAULT 0,
  claimed_until BIGINT NOT NULL DEFAULT 0,
  dynamic_list SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, path_hash)
);

CREATE INDEX IF NOT EXISTS idx_static_export_pages_list ON static_export_pages (site_id, dynamic_list);

/**
 * What each page shows: `c:<content id>` and `g:<translation group id>`.
 * Publishing or unpublishing an entry marks the pages that list it as stale.
 */
CREATE TABLE IF NOT EXISTS static_export_page_deps (
  site_id UUID NOT NULL,
  path_hash CHAR(64) NOT NULL,
  dep VARCHAR(80) NOT NULL,
  PRIMARY KEY (site_id, path_hash, dep),
  FOREIGN KEY (site_id, path_hash) REFERENCES static_export_pages(site_id, path_hash) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_static_export_page_deps_dep ON static_export_page_deps (site_id, dep);
