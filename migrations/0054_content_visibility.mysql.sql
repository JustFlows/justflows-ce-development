CREATE TABLE IF NOT EXISTS content_visibility (
  site_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  policy TEXT NOT NULL,
  policy_hash CHAR(64) NOT NULL,
  updated_by CHAR(36),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (site_id, group_id),
  CONSTRAINT fk_content_visibility_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX idx_content_visibility_hash (site_id, policy_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
