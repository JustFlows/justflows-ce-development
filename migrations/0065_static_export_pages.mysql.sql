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
  site_id CHAR(36) NOT NULL,
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
  PRIMARY KEY (site_id, path_hash),
  CONSTRAINT fk_static_export_pages_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_static_export_pages_list (site_id, dynamic_list)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/**
 * What each page shows: `c:<content id>` and `g:<translation group id>`.
 * Publishing or unpublishing an entry marks the pages that list it as stale.
 */
CREATE TABLE IF NOT EXISTS static_export_page_deps (
  site_id CHAR(36) NOT NULL,
  path_hash CHAR(64) NOT NULL,
  dep VARCHAR(80) NOT NULL,
  PRIMARY KEY (site_id, path_hash, dep),
  CONSTRAINT fk_static_export_page_deps_page FOREIGN KEY (site_id, path_hash)
    REFERENCES static_export_pages(site_id, path_hash) ON DELETE CASCADE,
  INDEX idx_static_export_page_deps_dep (site_id, dep)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
