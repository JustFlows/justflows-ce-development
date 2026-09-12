// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, resetDb } from "../db.js";
import { runAllMigrations, type DbDriver } from "../run-migrations.js";
import { getWorkingRevision, rowToSnapshot, upsertWorkingRevision } from "../content-revisions.js";
import { serializeContentRow } from "../content-api.js";
import {
  deliverScheduleEvents,
  setContentSchedule,
  transitionScheduledContent,
} from "../content-scheduling-db.js";

const hooks = vi.hoisted(() => ({
  dispatchGate: vi.fn(async () => {}),
  dispatchAction: vi.fn(async () => {}),
  applyFilter: vi.fn(async (_name: string, data: unknown) => data),
}));
const invalidate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugin-runtime.js", () => ({ getRuntimeHooks: () => hooks }));
vi.mock("../content-public.js", () => ({ invalidateContentCache: invalidate }));
vi.mock("../permalinks-db.js", () => ({
  uniquePermalinkSlug: async (item: { slug: string }) => item.slug,
  rememberContentPermalink: async () => {},
}));

// Explicit opt-in and a disposable database name prevent touching an installed site.
const enabled =
  process.env.SCHEDULE_TEST_DATABASE === "1" && process.env.DB_NAME === "schedule_test";
describe.skipIf(!enabled)("persisted publishing schedules", () => {
  const siteId = randomUUID();
  const userId = randomUUID();
  const actor = { siteId, userId, role: "administrator" };
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  const later = () => new Date(Date.now() + 7_200_000).toISOString();
  async function row(id: string) {
    return (
      await (
        await getDb()
      ).query<Record<string, unknown>>("SELECT * FROM content WHERE id = ?", [id])
    )[0]!;
  }
  async function create(status = "draft", locale = "en-US", group = randomUUID()) {
    const id = randomUUID();
    await (
      await getDb()
    ).run(
      "INSERT INTO content (id, site_id, type, title, slug, locale, translation_group_id, status, blocks, fields, version) VALUES (?, ?, 'custom', 'Original', ?, ?, ?, ?, ?, ?, 1)",
      [id, siteId, id, locale, group, status, '{"version":1,"blocks":[]}', "{}"],
    );
    return id;
  }
  beforeAll(async () => {
    const db = await getDb();
    const driver = process.env.DB_DRIVER as DbDriver;
    // Model the existing content/revision contract, then apply the real additive migration.
    const pg = driver === "postgres";
    const uuid = pg ? "UUID" : "CHAR(36)";
    const json = pg ? "JSONB" : "JSON";
    const stamp = pg ? "TIMESTAMPTZ" : "DATETIME";
    const suffix = pg ? "" : " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    if (pg)
      await db.run(
        "CREATE TYPE content_status AS ENUM ('draft','published','unpublished','trashed')",
      );
    const statusType = pg ? "content_status" : "ENUM('draft','published','unpublished','trashed')";
    await db.run(`CREATE TABLE sites (id ${uuid} PRIMARY KEY, name TEXT, url TEXT)${suffix}`);
    await db.run(
      `CREATE TABLE users (id ${uuid} PRIMARY KEY, site_id ${uuid}, email TEXT, username TEXT, display_name TEXT, password_hash TEXT, role TEXT)`,
    );
    await db.run(`CREATE TABLE content (
      id ${uuid} PRIMARY KEY, site_id ${uuid} NOT NULL REFERENCES sites(id),
      type VARCHAR(60), title VARCHAR(1024), slug VARCHAR(1024), locale VARCHAR(20), translation_group_id ${uuid},
      status ${statusType} NOT NULL DEFAULT 'draft', blocks ${json}, fields ${json}, excerpt TEXT, author_id ${uuid},
      published_at ${stamp}, trashed_at ${stamp}, version INT NOT NULL DEFAULT 1,
      created_at ${stamp} DEFAULT CURRENT_TIMESTAMP, updated_at ${stamp} DEFAULT CURRENT_TIMESTAMP
    )${suffix}`);
    await db.run(`CREATE TABLE revisions (
      id ${uuid} PRIMARY KEY, content_id ${uuid}, site_id ${uuid}, title VARCHAR(1024), slug VARCHAR(1024), excerpt TEXT,
      locale VARCHAR(20), translation_group_id ${uuid}, blocks ${json}, fields ${json}, version INT, base_version INT,
      ${pg ? "kind" : "`kind`"} VARCHAR(20), ${pg ? "source" : "`source`"} VARCHAR(20),
      created_by ${uuid}, updated_by ${uuid}, created_at ${stamp}, updated_at ${stamp}
    )`);
    await db.run(
      `CREATE TABLE site_settings (id ${uuid}, site_id ${uuid}, ${pg ? "key" : "`key`"} VARCHAR(255), value ${json})`,
    );
    await db.run(
      `CREATE TABLE audit_log (id ${uuid} PRIMARY KEY, site_id ${uuid}, occurred_at ${stamp}, action VARCHAR(100), outcome VARCHAR(20), actor_id ${uuid}, actor_email TEXT, actor_role TEXT, target TEXT, ip TEXT, user_agent TEXT, detail TEXT, metadata ${json})`,
    );
    await runAllMigrations(db, driver, ["0030_content_scheduling"]);
    expect((await runAllMigrations(db, driver, ["0030_content_scheduling"])).skipped).toContain(
      "0030_content_scheduling",
    );
    await db.run("INSERT INTO sites (id, name, url) VALUES (?, 'Scheduling test', ?)", [
      siteId,
      `https://${siteId}.example`,
    ]);
    await db.run(
      "INSERT INTO users (id, site_id, email, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'Test author', 'unused', 'administrator')",
      [userId, siteId, `${userId}@example.com`, userId],
    );
    // Only the queue columns used by the scheduler are needed in this fixture.

    const timestamp = driver === "postgres" ? "TIMESTAMPTZ" : "DATETIME";
    await db.run(
      `CREATE TABLE IF NOT EXISTS webhook_endpoints (id ${uuid} PRIMARY KEY, site_id ${uuid}, url TEXT, events TEXT, secret_ciphertext TEXT, active BOOLEAN)`,
    );
    await db.run(
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (id ${uuid} PRIMARY KEY, endpoint_id ${uuid}, site_id ${uuid}, event TEXT, payload TEXT, status VARCHAR(20), attempt_count INT, next_attempt_at ${timestamp}, created_at ${timestamp}, updated_at ${timestamp})`,
    );
    await db.run(
      "INSERT INTO webhook_endpoints (id, site_id, url, events, secret_ciphertext, active) VALUES (?, ?, 'https://example.com/hook', ?, 'unused', ?)",
      [randomUUID(), siteId, '["content.published","content.unpublished"]', true],
    );
  }, 30_000);
  beforeEach(() => {
    hooks.dispatchGate.mockClear();
    hooks.dispatchAction.mockClear();
    invalidate.mockReset().mockResolvedValue();
  });
  afterAll(async () => {
    await (await getDb()).close();
    resetDb();
  });

  it("sets, changes and cancels a schedule without publication events", async () => {
    const id = await create();
    await setContentSchedule(id, actor, {
      publishOn: future(),
      unpublishOn: later(),
      expectedVersion: 1,
    });
    expect(serializeContentRow(await row(id)).status).toBe("scheduled");
    expect(hooks.dispatchAction).not.toHaveBeenCalled();
    await setContentSchedule(id, actor, {
      publishOn: later(),
      unpublishOn: null,
      expectedVersion: 2,
    });
    await setContentSchedule(id, actor, { publishOn: null, unpublishOn: null, expectedVersion: 3 });
    expect(serializeContentRow(await row(id))).toMatchObject({
      status: "draft",
      publishOn: null,
      unpublishOn: null,
    });
    const audit = await (
      await getDb()
    ).query<{ action: string }>("SELECT action FROM audit_log WHERE target = ?", [id]);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "content.schedule_set",
        "content.schedule_changed",
        "content.schedule_cancelled",
      ]),
    );
  });
  it("rejects stale versions, wrong sites and expiry without publication", async () => {
    const id = await create();
    await expect(
      setContentSchedule(id, actor, { publishOn: future(), unpublishOn: null, expectedVersion: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setContentSchedule(
        id,
        { ...actor, siteId: randomUUID() },
        { publishOn: future(), unpublishOn: null, expectedVersion: 1 },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      setContentSchedule(id, actor, { publishOn: null, unpublishOn: later(), expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("publishes once across concurrent workers, persists webhook delivery and later expires", async () => {
    const id = await create();
    const publishOn = future();
    const unpublishOn = later();
    await setContentSchedule(id, actor, { publishOn, unpublishOn, expectedVersion: 1 });
    expect(await transitionScheduledContent(id, siteId)).toBe(false);
    const result = await Promise.all([
      transitionScheduledContent(id, siteId, new Date(publishOn)),
      transitionScheduledContent(id, siteId, new Date(publishOn)),
    ]);
    expect(result.sort()).toEqual([false, true]);
    expect(serializeContentRow(await row(id))).toMatchObject({
      status: "published",
      publishOn: null,
    });
    const deliveries = await (
      await getDb()
    ).query<{ payload: string }>("SELECT payload FROM webhook_deliveries WHERE site_id = ?", [
      siteId,
    ]);
    expect(deliveries.filter((d) => JSON.parse(d.payload).data.contentId === id)).toHaveLength(1);
    expect(await transitionScheduledContent(id, siteId, new Date(unpublishOn))).toBe(true);
    expect(serializeContentRow(await row(id))).toMatchObject({
      status: "draft",
      unpublishOn: null,
    });
  });
  it("keeps the live revision until due and leaves another translation unchanged", async () => {
    const group = randomUUID();
    const source = await create("draft", "en-US", group);
    const id = await create("published", "nl-NL", group);
    const live = await row(id);
    await upsertWorkingRevision(live, {
      snapshot: { ...rowToSnapshot(live), title: "Scheduled revision" },
      actorId: userId,
      source: "manual",
      baseVersion: 1,
    });
    const publishOn = future();
    await setContentSchedule(id, actor, { publishOn, unpublishOn: null, expectedVersion: 1 });
    expect((await row(id)).title).toBe("Original");
    expect((await getWorkingRevision(id, siteId))?.baseVersion).toBe(2);
    await transitionScheduledContent(id, siteId, new Date(publishOn));
    expect((await row(id)).title).toBe("Scheduled revision");
    expect(await getWorkingRevision(id, siteId)).toBeNull();
    expect((await row(source)).status).toBe("draft");
  });
  it("catches up after reopening the database and skips a completely missed window", async () => {
    const id = await create();
    const publishOn = future();
    const unpublishOn = later();
    await setContentSchedule(id, actor, { publishOn, unpublishOn, expectedVersion: 1 });
    await (await getDb()).close();
    resetDb();
    await transitionScheduledContent(id, siteId, new Date(unpublishOn));
    expect(serializeContentRow(await row(id))).toMatchObject({
      status: "draft",
      publishOn: null,
      unpublishOn: null,
    });
    const deliveries = await (
      await getDb()
    ).query<{ payload: string }>("SELECT payload FROM webhook_deliveries WHERE site_id = ?", [
      siteId,
    ]);
    expect(deliveries.filter((d) => JSON.parse(d.payload).data.contentId === id)).toHaveLength(0);
  });
  it("rolls back a vetoed transition, then retries with its deadline intact", async () => {
    const id = await create();
    const publishOn = future();
    await setContentSchedule(id, actor, { publishOn, unpublishOn: null, expectedVersion: 1 });
    hooks.dispatchGate.mockRejectedValueOnce(new Error("veto"));
    await expect(transitionScheduledContent(id, siteId, new Date(publishOn))).rejects.toThrow(
      "veto",
    );
    expect((await row(id)).status).toBe("scheduled");
    await transitionScheduledContent(id, siteId, new Date(publishOn));
    expect((await row(id)).status).toBe("published");
  });
  it("stores transition events for large content bodies", async () => {
    const id = await create();
    const publishOn = future();
    await (
      await getDb()
    ).run("UPDATE content SET fields = ? WHERE id = ?", [JSON.stringify({ body: "Long content ".repeat(10_000) }), id]);
    await setContentSchedule(id, actor, { publishOn, unpublishOn: null, expectedVersion: 1 });
    expect(await transitionScheduledContent(id, siteId, new Date(publishOn))).toBe(true);
    expect((await row(id)).status).toBe("published");
  });
  it("retains committed events when cache invalidation fails and delivers on retry", async () => {
    const id = await create();
    const publishOn = future();
    await setContentSchedule(id, actor, { publishOn, unpublishOn: null, expectedVersion: 1 });
    await transitionScheduledContent(id, siteId, new Date(publishOn));
    invalidate.mockRejectedValueOnce(new Error("cache down"));
    await expect(deliverScheduleEvents()).rejects.toThrow("cache down");
    await deliverScheduleEvents();
    expect(hooks.dispatchAction).toHaveBeenCalledWith(
      "content.published",
      expect.objectContaining({ contentId: id, siteId }),
      expect.anything(),
    );
    expect(await (await getDb()).query("SELECT * FROM content_schedule_events")).toHaveLength(0);
  });
});
