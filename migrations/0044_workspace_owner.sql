ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_owner_user_id ON tenants(owner_user_id);
