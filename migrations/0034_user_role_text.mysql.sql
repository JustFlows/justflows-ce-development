-- Plugin-registered roles (Shop's customer, for example) are stored on
-- users.role. The column was a closed ENUM; widen it so a plugin can add a
-- role without another core migration.
ALTER TABLE users MODIFY COLUMN role VARCHAR(32) NOT NULL DEFAULT 'subscriber';
