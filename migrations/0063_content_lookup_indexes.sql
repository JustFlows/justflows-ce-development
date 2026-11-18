/**
 * Every public page request asks which entries carry their own Cache-Control
 * override (`fields.cacheControl`). Without an index that is a scan of every
 * row; on a site with 100,000 posts it took about a second per request.
 * Overrides are rare, so a partial index holds only the entries that have one.
 */
CREATE INDEX IF NOT EXISTS idx_content_cache_control_override
  ON content (site_id)
  WHERE (fields->>'cacheControl') IS NOT NULL;

/**
 * A public page request looks up only the entries whose slug is one of its
 * path segments. The unique key starts (site_id, type, slug), and requests do
 * not know the type, so slug lookups need their own index.
 */
CREATE INDEX IF NOT EXISTS idx_content_site_slug ON content (site_id, slug);
