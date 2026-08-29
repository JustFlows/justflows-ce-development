// SPDX-License-Identifier: MIT

import type { PluginDatabaseDriver, PluginDatabaseProbeResult, PluginDatabaseTarget } from "@justflows/sdk";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

export function isLocalDatabaseHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.trim().toLowerCase());
}

export function sanitizeProbeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/:[^:@\s/]+@/g, ":****@")
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .slice(0, 200);
}

function sslForHost(host: string, ssl?: boolean, rejectUnauthorized?: boolean): {
  useSsl: boolean;
  rejectUnauthorized: boolean;
} {
  const isLocal = isLocalDatabaseHost(host);
  return {
    useSsl: ssl ?? !isLocal,
    rejectUnauthorized: rejectUnauthorized ?? true,
  };
}

async function probePostgres(target: PluginDatabaseTarget): Promise<{ version?: string }> {
  const { default: postgres } = await import("postgres");
  const { useSsl, rejectUnauthorized } = sslForHost(
    target.host,
    target.ssl,
    target.rejectUnauthorized,
  );
  const url = `postgres://${encodeURIComponent(target.username)}:${encodeURIComponent(target.password)}@${target.host}:${target.port}/${target.database}`;
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 8,
    ssl: useSsl ? { rejectUnauthorized } : false,
  });
  try {
    await sql`SELECT 1`;
    const rows = await sql<{ version: string }[]>`SELECT version()`;
    return { version: rows[0]?.version?.split(",")[0]?.slice(0, 80) };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function probeMysql(target: PluginDatabaseTarget): Promise<{ version?: string }> {
  const mysql = await import("mysql2/promise");
  const { useSsl, rejectUnauthorized } = sslForHost(
    target.host,
    target.ssl,
    target.rejectUnauthorized,
  );
  const conn = await mysql.createConnection({
    host: target.host,
    port: target.port,
    user: target.username,
    password: target.password,
    database: target.database,
    connectTimeout: 8000,
    ...(useSsl ? { ssl: { minVersion: "TLSv1.2" as const, rejectUnauthorized } } : {}),
  });
  try {
    await conn.query("SELECT 1");
    const [rows] = await conn.query("SELECT VERSION() AS version");
    const version = Array.isArray(rows)
      ? String((rows[0] as { version?: string } | undefined)?.version ?? "")
      : "";
    return { version: version.slice(0, 80) || undefined };
  } finally {
    await conn.end();
  }
}

export async function probeDatabase(target: PluginDatabaseTarget): Promise<PluginDatabaseProbeResult> {
  const started = Date.now();
  const tls = sslForHost(target.host, target.ssl, target.rejectUnauthorized).useSsl;
  try {
    const result =
      target.driver === "postgres" ? await probePostgres(target) : await probeMysql(target);
    return {
      ok: true,
      dialect: target.driver,
      serverVersion: result.version,
      tls,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeProbeError(err),
      dialect: target.driver,
      tls,
      latencyMs: Date.now() - started,
    };
  }
}

export async function probeSharedDatabase(): Promise<PluginDatabaseProbeResult> {
  const started = Date.now();
  const driver = (process.env.DB_DRIVER ?? "") as PluginDatabaseDriver;
  const host = process.env.DB_HOST ?? "localhost";
  const sslSetting = (process.env.DB_SSL ?? "").trim().toLowerCase();
  const tls =
    sslSetting === ""
      ? !isLocalDatabaseHost(host)
      : !["0", "false", "off", "disable"].includes(sslSetting);

  try {
    const { getDb } = await import("./db.js");
    const db = await getDb();
    const rows = await db.query<{ version?: string; VERSION?: string }>(
      driver === "postgres" ? "SELECT version() AS version" : "SELECT VERSION() AS version",
    );
    const version = String(rows[0]?.version ?? rows[0]?.VERSION ?? "").slice(0, 80) || undefined;
    return {
      ok: true,
      dialect: driver || undefined,
      serverVersion: version,
      tls,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeProbeError(err),
      dialect: driver || undefined,
      tls,
      latencyMs: Date.now() - started,
    };
  }
}
