-- Plugin-registered roles (Shop's customer, for example) are stored on
-- users.role. The column was a closed enum; widen it so a plugin can add a
-- role without another core migration.
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users ALTER COLUMN role TYPE varchar(32) USING role::text;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'subscriber';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
DROP TYPE IF EXISTS user_role;
