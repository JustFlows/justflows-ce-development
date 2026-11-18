/**
 * Every public page request asks which entries carry their own Cache-Control
 * override (`fields.cacheControl`). Without an index that is a scan of every
 * row; on a site with 100,000 posts it took about a second per request.
 * MariaDB cannot index an expression, so a virtual (not stored) column marks
 * the entries with a non-null override and is indexed with the site. Backups
 * skip generated columns, and nothing writes to it.
 */
ALTER TABLE content ADD COLUMN has_cache_control TINYINT(1)
  GENERATED ALWAYS AS (
    CASE
      WHEN JSON_TYPE(JSON_EXTRACT(fields, '$.cacheControl')) IS NULL THEN NULL
      WHEN JSON_TYPE(JSON_EXTRACT(fields, '$.cacheControl')) = 'NULL' THEN NULL
      ELSE 1
    END
  ) VIRTUAL;

CREATE INDEX idx_content_cache_control_override ON content (site_id, has_cache_control);

/**
 * A public page request looks up only the entries whose slug is one of its
 * path segments. The unique key starts (site_id, type, slug), and requests do
 * not know the type, so slug lookups need their own index.
 */
CREATE INDEX idx_content_site_slug ON content (site_id, slug(191));
