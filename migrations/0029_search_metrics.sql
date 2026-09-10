CREATE TABLE IF NOT EXISTS search_metrics (
  id UUID PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  token_count INTEGER NOT NULL,
  result_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS search_metrics_site_created ON search_metrics (site_id, created_at);
