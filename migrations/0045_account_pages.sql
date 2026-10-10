-- Control databases skip sites whose content belongs to a separate connection.
-- A separate database has local site rows and receives its own backfill.
-- Core account pages are private by content type, independent of their slug.
UPDATE content_types SET is_builtin = TRUE WHERE slug = 'account';
INSERT INTO content_types (id, site_id, slug, label, description, is_builtin, fields, created_at, updated_at)
SELECT CAST(CONCAT(SUBSTRING(MD5(CONCAT(s.id, ':core-account')),1,8),'-',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),9,4),'-4',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),14,3),'-8',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),18,3),'-',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),21,12)) AS UUID), s.id, 'account', 'Account', 'Private user account page', TRUE, CAST('[]' AS JSONB), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM sites s JOIN tenants tenant ON tenant.id = s.tenant_id LEFT JOIN content_types t ON t.site_id = s.id AND t.slug = 'account' WHERE t.id IS NULL AND s.status <> 'deleted' AND tenant.status <> 'deleted'
AND (s.database_choice = 'current' OR NOT EXISTS (
  SELECT 1 FROM tenant_databases d WHERE d.mode = 'separate'
  AND (d.site_id = s.id OR (d.site_id IS NULL AND d.tenant_id = s.tenant_id))
));
INSERT INTO content (id, site_id, type, status, slug, title, blocks, fields, locale, created_at, updated_at, published_at)
SELECT CAST(CONCAT(SUBSTRING(MD5(CONCAT(s.id, ':core-account')),1,8),'-',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),9,4),'-4',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),14,3),'-8',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),18,3),'-',SUBSTRING(MD5(CONCAT(s.id, ':core-account')),21,12)) AS UUID), s.id, 'account', CAST('published' AS content_status), 'account', 'Your account', CAST('{"version":1,"blocks":[{"id":"account-heading","type":"core.heading","version":1,"props":{"text":"Your account","level":1}},{"id":"account-controls","type":"core.account","version":1,"props":{"section":"controls"}},{"id":"account-profile","type":"core.account","version":1,"props":{"section":"profile"}},{"id":"account-plugins","type":"core.account","version":1,"props":{"section":"plugins"}},{"id":"account-workspaces","type":"core.account","version":1,"props":{"section":"workspaces"}}]}' AS JSONB), CAST('{}' AS JSONB),
COALESCE((SELECT l.code FROM languages l WHERE l.site_id = s.id AND l.is_default = TRUE LIMIT 1), 'en'),
CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM sites s JOIN tenants tenant ON tenant.id = s.tenant_id LEFT JOIN content c ON c.site_id = s.id AND c.type = 'account' WHERE c.id IS NULL AND s.status <> 'deleted' AND tenant.status <> 'deleted'
AND (s.database_choice = 'current' OR NOT EXISTS (
  SELECT 1 FROM tenant_databases d WHERE d.mode = 'separate'
  AND (d.site_id = s.id OR (d.site_id IS NULL AND d.tenant_id = s.tenant_id))
));
