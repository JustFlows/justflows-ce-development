-- MySQL 8+ and MariaDB 10.6+ share this file.
CREATE TABLE IF NOT EXISTS storage_quota_locks (
  site_id CHAR(36) NOT NULL PRIMARY KEY,
  CONSTRAINT fk_storage_quota_lock_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
