ALTER TABLE content MODIFY COLUMN status ENUM('draft','published','unpublished','trashed','scheduled') NOT NULL DEFAULT 'draft';
ALTER TABLE content ADD COLUMN publish_on DATETIME;
ALTER TABLE content ADD COLUMN unpublish_on DATETIME;
ALTER TABLE content ADD COLUMN schedule_actor_id CHAR(36);
CREATE INDEX content_publish_due ON content (publish_on);
CREATE INDEX content_unpublish_due ON content (unpublish_on);
CREATE TABLE content_schedule_events (
  id CHAR(36) PRIMARY KEY,
  content_id CHAR(36) NOT NULL,
  site_id CHAR(36) NOT NULL,
  event VARCHAR(40) NOT NULL,
  payload LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
  INDEX content_schedule_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
