// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { DbClient } from "../database/db.js";

export interface WorkspaceOwnerAccount {
  email: string;
  username: string;
  displayName: string;
  passwordHash: string;
}

/** Workspace administrators also need an account on the installation's root site. */
export async function ensureWorkspaceOwnerAccount(db: DbClient, owner: WorkspaceOwnerAccount, stamp: string): Promise<{ userId: string; siteId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    // Use the same root selection as host routing. Serialize account creation on the root row.
    const roots = await tx.query<{ id: string }>(
      "SELECT id FROM sites WHERE status <> 'deleted' ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE",
    );
    const siteId = roots[0]?.id;
    if (!siteId) throw new Error("The installation root site was not found.");
    const email = owner.email.trim().toLowerCase();
    const existing = await tx.query<{ id: string }>(
      "SELECT id FROM users WHERE site_id = ? AND email = ? LIMIT 1",
      [siteId, email],
    );
    if (existing[0]) return { userId: existing[0].id, siteId, created: false };

    const userId = randomUUID();
    const names = await tx.query<{ id: string }>(
      "SELECT id FROM users WHERE site_id = ? AND username = ? LIMIT 1",
      [siteId, owner.username],
    );
    const username = names[0] ? `${owner.username.slice(0, 23)}-${userId}` : owner.username;
    await tx.run(
      `INSERT INTO users (id, site_id, email, username, display_name, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'subscriber', ?, ?)`,
      [userId, siteId, email, username, owner.displayName, owner.passwordHash, stamp, stamp],
    );
    return { userId, siteId, created: true };
  });
}
