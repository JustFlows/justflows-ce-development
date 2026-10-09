-- Separate lock rows avoid blocking media/private-file foreign-key checks.
CREATE TABLE IF NOT EXISTS storage_quota_locks (
  site_id UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE
);
