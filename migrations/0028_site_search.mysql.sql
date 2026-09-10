CREATE TABLE IF NOT EXISTS search_documents (
  content_id CHAR(36) PRIMARY KEY,
  site_id CHAR(36) NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  summary TEXT NOT NULL,
  body LONGTEXT NOT NULL,
  indexed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX search_documents_site (site_id),
  FULLTEXT INDEX search_documents_fts (title, slug, summary, body),
  FULLTEXT INDEX search_documents_title (title),
  FULLTEXT INDEX search_documents_slug (slug),
  FULLTEXT INDEX search_documents_summary (summary)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
