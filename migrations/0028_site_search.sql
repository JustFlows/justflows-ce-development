-- Shared live-row index; draft rows are only eligible for authorized admin queries.
CREATE TABLE IF NOT EXISTS search_documents (
  content_id UUID PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', slug), 'B') ||
    setweight(to_tsvector('simple', summary), 'C') ||
    setweight(to_tsvector('simple', body), 'D')
  ) STORED
);
CREATE INDEX IF NOT EXISTS search_documents_fts ON search_documents USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS search_documents_site ON search_documents(site_id);
