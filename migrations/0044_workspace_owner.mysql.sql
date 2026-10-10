ALTER TABLE tenants ADD COLUMN owner_user_id CHAR(36) NULL,
  ADD INDEX idx_tenants_owner_user_id (owner_user_id),
  ADD CONSTRAINT fk_tenants_owner_user FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
