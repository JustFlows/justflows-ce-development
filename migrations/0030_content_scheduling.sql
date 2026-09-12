ALTER TYPE content_status ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TABLE content ADD COLUMN publish_on TIMESTAMPTZ;
ALTER TABLE content ADD COLUMN unpublish_on TIMESTAMPTZ;
ALTER TABLE content ADD COLUMN schedule_actor_id UUID;
CREATE INDEX content_publish_due ON content (publish_on);
CREATE INDEX content_unpublish_due ON content (unpublish_on);
CREATE TABLE content_schedule_events (
  id UUID PRIMARY KEY,
  content_id UUID NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event VARCHAR(40) NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX content_schedule_events_created ON content_schedule_events (created_at);
