// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";

export const DEFAULT_ACCOUNT_BLOCKS = { version: 1, blocks: [
  { id: "account-heading", type: "core.heading", version: 1, props: { text: "Your account", level: 1 } },
  { id: "account-intro", type: "core.paragraph", version: 1, props: { text: "Your details and services in one place." } },
  ...["controls", "profile", "plugins", "workspaces"].map(section => ({ id: `account-${section}`, type: "core.account", version: 1, props: { section, sectionId: "", showTitles: true } })),
] };

interface AccountPageDb {
  query<T>(sql: string, params: string[]): Promise<T[]>;
  run(sql: string, params: string[]): Promise<unknown>;
}

/** Idempotent install/backfill seed. Never replaces a customized, renamed or draft page. */
export async function seedAccountPage(db: AccountPageDb, siteId: string, locale: string): Promise<void> {
  const pages = await db.query<{ id: string }>("SELECT id FROM content WHERE site_id = ? AND type = 'account' LIMIT 1", [siteId]);
  if (pages.length) return;
  const stamp = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  try {
    await db.run(`INSERT INTO content (id, site_id, type, status, slug, title, blocks, fields, locale, created_at, updated_at, published_at)
      VALUES (?, ?, 'account', 'published', 'account', 'Your account', ?, '{}', ?, ?, ?, ?)`,
      [randomUUID(), siteId, JSON.stringify(DEFAULT_ACCOUNT_BLOCKS), locale, stamp, stamp, stamp]);
  } catch (error) {
    // A concurrent installer may have won the unique (site, type, slug, locale) key.
    if (!/unique|duplicate/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const existing = await db.query<{ id: string }>("SELECT id FROM content WHERE site_id = ? AND type = 'account' LIMIT 1", [siteId]);
    if (!existing.length) throw error;
  }
}
