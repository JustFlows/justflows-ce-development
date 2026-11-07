CREATE TABLE IF NOT EXISTS content_visibility (
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  group_id UUID NOT NULL,
  policy TEXT NOT NULL,
  policy_hash CHAR(64) NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (site_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_content_visibility_hash ON content_visibility(site_id, policy_hash);
