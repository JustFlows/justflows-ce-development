/**
 * History of site-wide builder documents (justflows-ce#302): header library,
 * footer, widget areas, and template overrides. Every save records the
 * document as written, so an editor can compare and restore earlier versions.
 * The newest versions per document are kept; older ones are pruned on write.
 */
CREATE TABLE IF NOT EXISTS document_history (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    UUID         NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  doc_kind   VARCHAR(40)  NOT NULL,
  doc_key    VARCHAR(400) NOT NULL,
  revision   INTEGER      NOT NULL,
  state      VARCHAR(16)  NOT NULL,
  doc        JSONB        NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_history_doc ON document_history(site_id, doc_kind, doc_key, created_at);
