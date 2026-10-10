// SPDX-License-Identifier: MIT

import { getDb } from "../database/db.js";
import { getTenantContext } from "../tenancy/context.js";

/** Read only public profile fields belonging to this site's authenticated user. */
export async function accountProfile(siteId: string, userId: string) {
  const db = await getDb();
  const shared = getTenantContext()?.userMode === "shared";
  const rows = await db.query<{ username: string; display_name: string }>(
    shared
      ? `SELECT u.username, u.display_name FROM users u
         JOIN sites home ON home.id = u.site_id
         JOIN sites current_site ON current_site.tenant_id = home.tenant_id AND current_site.id = ?
         LEFT JOIN site_memberships m ON m.user_id = u.id AND m.site_id = current_site.id
         WHERE u.id = ? AND (u.site_id = current_site.id OR m.user_id IS NOT NULL) LIMIT 1`
      : "SELECT username, display_name FROM users WHERE site_id = ? AND id = ? LIMIT 1",
    [siteId, userId],
  );
  return rows[0] ?? null;
}
