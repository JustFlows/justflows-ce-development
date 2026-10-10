// SPDX-License-Identifier: MIT

import type { PluginDeleteCreatedByResult } from "@justflows/sdk";
import { getDb } from "../database/db.js";
import { clearBlogPagesIfMatch } from "./blog-page.js";
import { clearHomePagesIfMatch } from "./home-page.js";
import { invalidateContentCache } from "./content-public.js";
import { clearErrorPagesIfMatch } from "../rendering/error-pages.js";
import { liveUploadKey, trashedUploadKeyCandidates } from "../media/upload-paths.js";
import { getUploadStore } from "../media/upload-store.js";
import { removeVariantDir } from "../media/media-responsive.js";

const USER_ID = /^[A-Za-z0-9-]{1,64}$/;

interface OwnedContent {
  id: string;
  type: string;
}

interface OwnedMedia {
  id: string;
  storage_key: string;
}

async function unlinkStorage(storageKey: string): Promise<void> {
  const store = getUploadStore();
  const live = liveUploadKey(storageKey);
  for (const key of [...(live ? [live] : []), ...trashedUploadKeyCandidates(storageKey)]) {
    await store.delete(key);
  }
}

/**
 * Delete content, media, and comments attributed to one user.
 * An administrator is refused before any row is removed.
 */
export async function deleteRecordsCreatedBy(
  siteId: string,
  userId: string,
): Promise<PluginDeleteCreatedByResult> {
  if (!USER_ID.test(userId)) return { ok: false, error: "Unknown user." };
  const db = await getDb();
  const users = await db.query<{ role: string }>(
    "SELECT role FROM users WHERE id = ? AND site_id = ? LIMIT 1",
    [userId, siteId],
  );
  const role = users[0]?.role;
  if (!role) return { ok: false, error: "That user does not exist." };
  if (role === "administrator") {
    return { ok: false, error: "Refusing to delete records created by an administrator." };
  }

  const content = await db.query<OwnedContent>(
    "SELECT id, type FROM content WHERE site_id = ? AND author_id = ?",
    [siteId, userId],
  );
  const contentIds = new Set(content.map((row) => row.id));
  await clearHomePagesIfMatch(siteId, contentIds);
  await clearBlogPagesIfMatch(siteId, contentIds);
  await clearErrorPagesIfMatch(siteId, contentIds);

  await db.run(
    "DELETE FROM revisions WHERE site_id = ? AND created_by = ? AND kind IN ('working', 'autosave')",
    [siteId, userId],
  );
  if (content.length > 0) {
    const placeholders = content.map(() => "?").join(", ");
    await db.run(
      `DELETE FROM revisions WHERE site_id = ? AND content_id IN (${placeholders})`,
      [siteId, ...content.map((row) => row.id)],
    );
  }

  const comments = await db.query<{ id: string }>(
    "SELECT id FROM comments WHERE site_id = ? AND user_id = ?",
    [siteId, userId],
  );
  await db.run("DELETE FROM comments WHERE site_id = ? AND user_id = ?", [siteId, userId]);
  await db.run("DELETE FROM content WHERE site_id = ? AND author_id = ?", [siteId, userId]);

  const media = await db.query<OwnedMedia>(
    "SELECT id, storage_key FROM media WHERE site_id = ? AND uploaded_by = ?",
    [siteId, userId],
  );
  await db.run("DELETE FROM media WHERE site_id = ? AND uploaded_by = ?", [siteId, userId]);
  for (const row of media) {
    if (row.storage_key) await unlinkStorage(String(row.storage_key)).catch(() => undefined);
    await removeVariantDir(siteId, row.id).catch(() => undefined);
  }

  if (content.length > 0 || media.length > 0 || comments.length > 0) {
    await invalidateContentCache();
  }
  const { indexSearchContent } = await import("../search/search-db.js");
  for (const row of content) {
    await indexSearchContent(siteId, row.id).catch(() => undefined);
  }

  const { getRuntimeHooks } = await import("../plugins/plugin-runtime.js");
  const hooks = getRuntimeHooks();
  for (const row of content) {
    await hooks.dispatchAction(
      "content.deleted",
      { contentId: row.id, siteId, type: row.type },
      { siteId, source: "system" },
    );
  }
  for (const row of media) {
    await hooks.dispatchAction("media.deleted", { siteId, mediaId: row.id }, { siteId, source: "system" });
  }

  return {
    ok: true,
    content: content.length,
    media: media.length,
    comments: comments.length,
  };
}
