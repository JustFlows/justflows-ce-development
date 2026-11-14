/**
 * History of site-wide builder documents (justflows-ce#302): header library,
 * footer, widget areas, and template overrides. Every save records the
 * document as written, so an editor can compare and restore earlier versions.
 * The newest versions per document are kept; older ones are pruned on write.
 */
CREATE TABLE IF NOT EXISTS document_history (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  site_id    CHAR(36)     NOT NULL,
  doc_kind   VARCHAR(40)  NOT NULL,
  doc_key    VARCHAR(400) NOT NULL,
  revision   INT          NOT NULL,
  state      VARCHAR(16)  NOT NULL,
  doc        JSON         NOT NULL,
  created_by CHAR(36),
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_document_history_doc (site_id, doc_kind, doc_key, created_at),
  CONSTRAINT fk_document_history_site FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
