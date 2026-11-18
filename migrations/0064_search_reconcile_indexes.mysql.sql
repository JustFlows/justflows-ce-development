/**
 * The search reconcile job runs every minute and compares each entry's
 * `updated_at` with its search document's `indexed_at`. Without these
 * indexes that read every full content and search row; on a site with
 * 100,000 posts it took 2 to 7 seconds of database time each minute. With
 * them the comparison reads only the indexes (about 0.1 s on the same site).
 */
CREATE INDEX idx_content_site_id_updated ON content (site_id, id, updated_at);
CREATE INDEX idx_search_documents_indexed ON search_documents (content_id, indexed_at);

/**
 * Refresh index statistics. Right after the indexes were created, MariaDB
 * kept choosing the older `(site_id)` index on a 100,000-post test site and
 * read every full content row (about 1.2 s per run instead of 0.1 s) until
 * the statistics were updated.
 */
ANALYZE TABLE content, search_documents;
