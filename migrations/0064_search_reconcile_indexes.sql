/**
 * The search reconcile job runs every minute and compares each entry's
 * `updated_at` with its search document's `indexed_at`. Without these
 * indexes that read every full content and search row; on a site with
 * 100,000 posts it took 2 to 7 seconds of database time each minute. With
 * them the comparison reads only the indexes (about 0.1 s on the same site).
 */
CREATE INDEX IF NOT EXISTS idx_content_site_id_updated ON content (site_id, id, updated_at);
CREATE INDEX IF NOT EXISTS idx_search_documents_indexed ON search_documents (content_id, indexed_at);

/**
 * Refresh planner statistics so the new indexes are used from the first run,
 * not after the next automatic statistics update.
 */
ANALYZE content;
ANALYZE search_documents;
