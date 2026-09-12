// SPDX-License-Identifier: MIT

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { JobScheduler } from "@justflows/jobs";
import type { HookContext } from "@justflows/core";
import { getDb, type DbClient } from "./db.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import { validateWebhookUrl } from "./webhook-url.js";

export const CORE_WEBHOOK_EVENTS = [
  "content.created",
  "content.updated",
  "content.published",
  "content.unpublished",
  "content.deleted",
  "media.uploaded",
  "media.deleted",
  "user.created",
  "user.updated",
  "user.deleted",
  "auth.login",
  "auth.logout",
  "plugin.installed",
  "plugin.activated",
  "plugin.deactivated",
  "plugin.uninstalled",
  "theme.installed",
  "theme.activated",
  "core.updated",
] as const;
export const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 5;
const scheduler = new JobScheduler(console);
let started = false;
const registeredEvents = new Set<string>();

export type WebhookEndpoint = {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type EndpointRow = Record<string, unknown> & {
  id: string;
  site_id: string;
  url: string;
  events: string;
  secret_ciphertext: string;
};

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
function date(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
/** `YYYY-MM-DD HH:MM:SS` — the shape MySQL DATETIME accepts and SQLite sorts correctly. */
function sqlTime(value: Date = new Date()): string {
  return value.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
function endpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    events: JSON.parse(String(row.events)) as string[],
    active: bool(row.active),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function createWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function signWebhookPayload(secret: string, timestamp: string, payload: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

export async function listWebhookEventTypes(): Promise<string[]> {
  const { getRuntimeHooks } = await import("./plugin-runtime.js");
  const filtered: unknown = await getRuntimeHooks().applyFilter(
    "webhook.eventTypes",
    [...CORE_WEBHOOK_EVENTS] as string[],
    {},
  );
  if (!Array.isArray(filtered)) return [...CORE_WEBHOOK_EVENTS];
  return [
    ...new Set(
      filtered.filter(
        (item): item is string =>
          typeof item === "string" && /^[a-z][a-z0-9_.:-]{1,159}$/i.test(item),
      ),
    ),
  ].sort();
}

export async function listWebhooks(siteId: string): Promise<WebhookEndpoint[]> {
  const rows = await (
    await getDb()
  ).query<Record<string, unknown>>(
    "SELECT id, name, url, events, active, created_at, updated_at FROM webhook_endpoints WHERE site_id = ? ORDER BY created_at DESC",
    [siteId],
  );
  return rows.map(endpoint);
}

export async function createWebhook(
  siteId: string,
  input: { name: string; url: string; events: string[] },
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const url = await validateWebhookUrl(input.url);
  const allowed = new Set(await listWebhookEventTypes());
  if (input.events.some((event) => !allowed.has(event)))
    throw new Error("One or more event types are not registered");
  const id = randomUUID();
  const secret = createWebhookSecret();
  const stamp = new Date();
  const now = sqlTime(stamp);
  await (
    await getDb()
  ).run(
    "INSERT INTO webhook_endpoints (id, site_id, name, url, events, secret_ciphertext, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      siteId,
      input.name,
      url.toString(),
      JSON.stringify([...new Set(input.events)]),
      encryptSecret(secret),
      true,
      now,
      now,
    ],
  );
  return {
    endpoint: {
      id,
      name: input.name,
      url: url.toString(),
      events: [...new Set(input.events)],
      active: true,
      createdAt: stamp.toISOString(),
      updatedAt: stamp.toISOString(),
    },
    secret,
  };
}

export async function updateWebhook(
  siteId: string,
  id: string,
  input: { name: string; url: string; events: string[]; active: boolean },
): Promise<WebhookEndpoint | null> {
  const url = await validateWebhookUrl(input.url);
  const allowed = new Set(await listWebhookEventTypes());
  if (input.events.some((event) => !allowed.has(event)))
    throw new Error("One or more event types are not registered");
  const now = sqlTime();
  await (
    await getDb()
  ).run(
    "UPDATE webhook_endpoints SET name = ?, url = ?, events = ?, active = ?, updated_at = ? WHERE id = ? AND site_id = ?",
    [
      input.name,
      url.toString(),
      JSON.stringify([...new Set(input.events)]),
      input.active,
      now,
      id,
      siteId,
    ],
  );
  const rows = await (
    await getDb()
  ).query<Record<string, unknown>>(
    "SELECT id, name, url, events, active, created_at, updated_at FROM webhook_endpoints WHERE id = ? AND site_id = ?",
    [id, siteId],
  );
  return rows[0] ? endpoint(rows[0]) : null;
}

export async function deleteWebhook(siteId: string, id: string): Promise<void> {
  await (
    await getDb()
  ).run("DELETE FROM webhook_endpoints WHERE id = ? AND site_id = ?", [id, siteId]);
}

export async function rotateWebhookSecret(siteId: string, id: string): Promise<string | null> {
  const rows = await (
    await getDb()
  ).query<{ id: string }>("SELECT id FROM webhook_endpoints WHERE id = ? AND site_id = ?", [
    id,
    siteId,
  ]);
  if (!rows[0]) return null;
  const secret = createWebhookSecret();
  await (
    await getDb()
  ).run(
    "UPDATE webhook_endpoints SET secret_ciphertext = ?, updated_at = ? WHERE id = ? AND site_id = ?",
    [encryptSecret(secret), sqlTime(), id, siteId],
  );
  return secret;
}

export async function enqueueWebhookEvent(
  event: string,
  data: unknown,
  context: HookContext = {},
  client?: Pick<DbClient, "run" | "query">,
): Promise<number> {
  const siteId =
    context.siteId ??
    (data && typeof data === "object" && "siteId" in data
      ? String((data as { siteId: unknown }).siteId)
      : "");
  if (!siteId) return 0;
  const { getRuntimeHooks } = await import("./plugin-runtime.js");
  const filteredData = await getRuntimeHooks().applyFilter(
    "webhook.payload",
    data,
    { event, siteId },
    context,
  );
  const envelope = {
    id: randomUUID(),
    event,
    createdAt: new Date().toISOString(),
    data: filteredData,
  };
  const payload = JSON.stringify(envelope);
  if (Buffer.byteLength(payload) > MAX_WEBHOOK_PAYLOAD_BYTES)
    throw new Error("Webhook payload exceeds 256 KiB");
  const db = client ?? await getDb();
  const endpoints = await db.query<EndpointRow>(
    "SELECT id, site_id, url, events, secret_ciphertext FROM webhook_endpoints WHERE site_id = ? AND active = ?",
    [siteId, true],
  );
  let count = 0;
  const now = sqlTime();
  for (const target of endpoints) {
    const events = JSON.parse(String(target.events)) as string[];
    if (!events.includes(event)) continue;
    await db.run(
      "INSERT INTO webhook_deliveries (id, endpoint_id, site_id, event, payload, status, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
      [randomUUID(), target.id, siteId, event, payload, now, now, now],
    );
    count++;
  }
  if (count > 0 && !client) scheduler.enqueue("webhooks.deliver");
  return count;
}

function backoff(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

export async function processDueWebhookDeliveries(): Promise<number> {
  const db = await getDb();
  const now = sqlTime();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT d.id, d.endpoint_id, d.site_id, d.payload, d.attempt_count, e.url, e.secret_ciphertext FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND e.active = ? ORDER BY d.next_attempt_at ASC LIMIT 20",
    [now, true],
  );
  for (const row of rows) await deliver(row);
  return rows.length;
}

async function deliver(row: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  const id = String(row.id);
  const attempt = Number(row.attempt_count) + 1;
  await db.run(
    "UPDATE webhook_deliveries SET status = 'processing', attempt_count = ?, updated_at = ? WHERE id = ?",
    [attempt, sqlTime(), id],
  );
  try {
    const url = await validateWebhookUrl(String(row.url));
    const payload = String(row.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhookPayload(decryptSecret(row.secret_ciphertext), timestamp, payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "user-agent": "Justflows-Webhooks/1.0",
          "x-justflows-delivery": id,
          "x-justflows-timestamp": timestamp,
          "x-justflows-signature": `sha256=${signature}`,
        },
        body: payload,
      });
    } finally {
      clearTimeout(timer);
    }
    const responseBody = (await response.text()).slice(0, 2048);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseBody}`);
    const done = sqlTime();
    await db.run(
      "UPDATE webhook_deliveries SET status = 'delivered', response_status = ?, response_body = ?, error = NULL, delivered_at = ?, updated_at = ? WHERE id = ?",
      [response.status, responseBody, done, done, id],
    );
    await notifyDelivery(row, attempt, "delivered", response.status, responseBody, null);
  } catch (error) {
    const terminal = attempt >= MAX_ATTEMPTS;
    const next = sqlTime(new Date(Date.now() + backoff(attempt)));
    await db.run(
      "UPDATE webhook_deliveries SET status = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
      [
        terminal ? "failed" : "pending",
        String(error).slice(0, 1024),
        next,
        sqlTime(),
        id,
      ],
    );
    await notifyDelivery(row, attempt, terminal ? "failed" : "retrying", null, null, String(error));
  }
}

async function notifyDelivery(
  row: Record<string, unknown>,
  attempt: number,
  status: "delivered" | "retrying" | "failed",
  responseStatus: number | null,
  responseBody: string | null,
  error: string | null,
): Promise<void> {
  const parsed = JSON.parse(String(row.payload)) as { event?: string; data?: unknown };
  const { getRuntimeHooks } = await import("./plugin-runtime.js");
  await getRuntimeHooks().dispatchAction(
    "webhook.delivered",
    {
      deliveryId: String(row.id),
      endpointId: String(row.endpoint_id),
      event: parsed.event ?? "unknown",
      data: parsed.data,
      attempt,
      status,
      responseStatus,
      responseBody,
      error,
    },
    { siteId: String(row.site_id), source: "job" },
  );
}

export async function refreshWebhookEventHooks(): Promise<void> {
  const { getRuntimeHooks } = await import("./plugin-runtime.js");
  const hooks = getRuntimeHooks();
  for (const event of await listWebhookEventTypes()) {
    if (registeredEvents.has(event)) continue;
    hooks.action(
      event,
      async (payload, context) => {
        // Scheduled transitions already persisted delivery rows atomically.
        if (context.source === "job" && payload && typeof payload === "object" && "scheduleEventId" in payload) return;
        await enqueueWebhookEvent(event, payload, context);
      },
      { id: `core.webhook.${event}` },
    );
    registeredEvents.add(event);
  }
}

export async function listWebhookDeliveries(
  siteId: string,
  endpointId?: string,
): Promise<Record<string, unknown>[]> {
  const db = await getDb();
  const params: string[] = [siteId];
  let where = "d.site_id = ?";
  if (endpointId) {
    where += " AND d.endpoint_id = ?";
    params.push(endpointId);
  }
  return db.query<Record<string, unknown>>(
    `SELECT d.id, d.endpoint_id, e.name AS endpoint_name, d.event, d.status, d.attempt_count, d.response_status, d.response_body, d.error, d.next_attempt_at, d.created_at, d.delivered_at FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE ${where} ORDER BY d.created_at DESC LIMIT 100`,
    params,
  );
}

export async function redeliverWebhook(siteId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const found = await db.query<{ id: string }>(
    "SELECT id FROM webhook_deliveries WHERE id = ? AND site_id = ?",
    [id, siteId],
  );
  if (!found[0]) return false;
  await db.run(
    "UPDATE webhook_deliveries SET status = 'pending', attempt_count = 0, response_status = NULL, response_body = NULL, error = NULL, next_attempt_at = ?, delivered_at = NULL, updated_at = ? WHERE id = ? AND site_id = ?",
    [sqlTime(), sqlTime(), id, siteId],
  );
  scheduler.enqueue("webhooks.deliver");
  return true;
}

export async function startWebhookJobs(): Promise<void> {
  if (started) return;
  started = true;
  // A process can stop after claiming a row. Put those durable claims back in
  // the queue on boot so a deploy or crash cannot strand a delivery forever.
  await (
    await getDb()
  ).run(
    "UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'processing'",
    [sqlTime(), sqlTime()],
  );
  scheduler.register({
    name: "webhooks.deliver",
    schedule: "* * * * *",
    maxAttempts: 1,
    async handler() {
      const count = await processDueWebhookDeliveries();
      return { success: true, message: `Processed ${count} deliveries` };
    },
  });
  scheduler.start();
  await refreshWebhookEventHooks();
}
