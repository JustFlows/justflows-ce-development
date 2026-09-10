CREATE TABLE IF NOT EXISTS search_metrics (
  id CHAR(36) PRIMARY KEY,
  site_id CHAR(36) NOT NULL,
  token_count INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX search_metrics_site_created (site_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
