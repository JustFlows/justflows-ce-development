/**
 * Lightweight database client for the admin app.
 * Reads connection config from env vars written by the install wizard.
 * Returns a simple run/query interface compatible with both postgres and mysql2.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { envFilePath } from "../runtime/jf-root.js";
import { recordDatabaseTiming } from "../runtime/diagnostics.js";

/** Load .env from repo root (survives Plesk restarts). */
function ensureEnvLoaded() {
  if (process.env.DB_DRIVER) return;
  try {
    const contents = fs.readFileSync(envFilePath(), "utf-8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env not yet written — install hasn't run
  }
}

/** A single connection pinned out of the pool — used to hold a session-scoped lock. */
export interface ReservedDbClient {
  run(sql: string, params?: (string | number | boolean | null)[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: (string | number | boolean | null)[]): Promise<T[]>;
  /** Return the connection to the pool. */
  release(): void;
}

export interface DbClient {
  run(sql: string, params?: (string | number | boolean | null)[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: (string | number | boolean | null)[]): Promise<T[]>;
  execute(sql: string, params?: (string | number | boolean | null)[]): Promise<number>;
  transaction<T>(fn: (tx: Pick<DbClient, "run" | "query" | "execute">) => Promise<T>): Promise<T>;
  /**
   * Pin one connection so a caller can hold a session-scoped lock across
   * statements. Only pooled clients (getDb) provide it; single-connection
   * clients omit it and callers fall back to running unlocked.
   */
  reserve?(): Promise<ReservedDbClient>;
  close(): Promise<void>;
}

let _client: DbClient | null = null;

const requestDatabase = new AsyncLocalStorage<DbClient>();
const controlDatabase = new AsyncLocalStorage<{ client: DbClient; active: boolean }>();

/** Reuse a held control transaction; delayed work reverts to the normal pool. */
export async function runWithControlDatabase<T>(client: DbClient, fn: () => Promise<T>): Promise<T> {
  const context = { client, active: true };
  try { return await controlDatabase.run(context, fn); }
  finally { context.active = false; }
}

/** Run `fn` so `getDb()` returns this connection instead of the installation database. */
export function runWithDatabase<T>(client: DbClient, fn: () => T): T {
  return requestDatabase.run(client, fn);
}

export interface DbConnectionConfig {
  driver: "postgres" | "mysql" | "mariadb";
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

function instrumentClient(client: DbClient): DbClient {
  const timed = <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>) =>
    async (...args: TArgs): Promise<TResult> => {
      const started = performance.now();
      try {
        return await fn(...args);
      } finally {
        recordDatabaseTiming(performance.now() - started);
      }
    };
  return {
    ...client,
    run: timed(client.run.bind(client)),
    query: timed(client.query.bind(client)) as DbClient["query"],
    execute: timed(client.execute.bind(client)),
    transaction: timed(client.transaction.bind(client)) as DbClient["transaction"],
    reserve: client.reserve?.bind(client),
    close: client.close.bind(client),
  };
}

export async function getDb(): Promise<DbClient> {
  const scoped = requestDatabase.getStore();
  const control = controlDatabase.getStore();
  if (scoped && scoped !== _client && scoped !== control?.client) return scoped;
  return getControlDb();
}

/** The installation database. Routing and platform records always live here. */
export async function getControlDb(): Promise<DbClient> {
  const scoped = controlDatabase.getStore();
  if (scoped?.active) return scoped.client;
  if (_client) return _client;
  ensureEnvLoaded();
  const driver = process.env.DB_DRIVER as DbConnectionConfig["driver"] | undefined;
  if (!driver) {
    throw new Error("DB_DRIVER not set — run the install wizard first.");
  }
  _client = await createDbClient({
    driver,
    host: process.env.DB_HOST ?? "localhost",
    port: process.env.DB_PORT ?? (driver === "postgres" ? "5432" : "3306"),
    database: process.env.DB_NAME ?? "justflows",
    username: process.env.DB_USER ?? "",
    password: process.env.DB_PASSWORD ?? "",
  });
  return _client;
}

export async function createDbClient(config: DbConnectionConfig): Promise<DbClient> {
  const driver = config.driver;
  const host = config.host;
  const port = config.port;
  const database = config.database;
  const username = config.username;
  const password = config.password;

  ensureEnvLoaded();

  // Neither driver negotiates TLS on its own, so a managed database (Neon, RDS,
  // PlanetScale) was reached in cleartext — credentials and content included.
  // Default to requiring TLS whenever the host is not local; DB_SSL forces it
  // either way.
  const sslSetting = (process.env.DB_SSL ?? "").trim().toLowerCase();
  const isLocalHost = ["localhost", "127.0.0.1", "::1", ""].includes(host.toLowerCase());
  const useSsl = sslSetting === "" ? !isLocalHost : !["0", "false", "off", "disable"].includes(sslSetting);
  // Set DB_SSL_REJECT_UNAUTHORIZED=0 only for a self-signed server certificate.
  const rejectUnauthorized = !["0", "false", "off"].includes(
    (process.env.DB_SSL_REJECT_UNAUTHORIZED ?? "").trim().toLowerCase(),
  );

  if (driver === "postgres") {
    const { default: postgres } = await import("postgres");
    const url = `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
    const sql = postgres(url, {
      max: 5,
      ssl: useSsl ? { rejectUnauthorized } : false,
    });

    return instrumentClient({
      run: async (query, params = []) => {
        let i = 0;
        const pgQuery = query.replace(/\?/g, () => `$${++i}`);
        await sql.unsafe(pgQuery, params as Parameters<typeof sql.unsafe>[1]);
      },
      query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
        let i = 0;
        const pgQuery = query.replace(/\?/g, () => `$${++i}`);
        const rows = await sql.unsafe(pgQuery, params as Parameters<typeof sql.unsafe>[1]);
        return rows as unknown as T[];
      },
      execute: async (query, params = []) => {
        let i = 0;
        const pgQuery = query.replace(/\?/g, () => `$${++i}`);
        const rows = await sql.unsafe(pgQuery, params as Parameters<typeof sql.unsafe>[1]);
        return Number((rows as { count?: number }).count ?? 0);
      },
      transaction: async (fn) => {
        const value = await sql.begin(async (txSql) => {
          const tx = {
            run: async (query: string, params: (string | number | boolean | null)[] = []) => {
              let i = 0;
              const pgQuery = query.replace(/\?/g, () => `$${++i}`);
              await txSql.unsafe(pgQuery, params as Parameters<typeof txSql.unsafe>[1]);
            },
            query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
              let i = 0;
              const pgQuery = query.replace(/\?/g, () => `$${++i}`);
              const rows = await txSql.unsafe(pgQuery, params as Parameters<typeof txSql.unsafe>[1]);
              return rows as unknown as T[];
            },
            execute: async (query: string, params: (string | number | boolean | null)[] = []) => {
              let i = 0;
              const pgQuery = query.replace(/\?/g, () => `$${++i}`);
              const rows = await txSql.unsafe(pgQuery, params as Parameters<typeof txSql.unsafe>[1]);
              return Number((rows as { count?: number }).count ?? 0);
            },
          };
          return fn(tx);
        });
        return value as Awaited<ReturnType<typeof fn>>;
      },
      reserve: async () => {
        const reserved = await sql.reserve();
        const exec = (query: string, params: (string | number | boolean | null)[]) => {
          let i = 0;
          const pgQuery = query.replace(/\?/g, () => `$${++i}`);
          return reserved.unsafe(pgQuery, params as Parameters<typeof reserved.unsafe>[1]);
        };
        return {
          run: async (query, params = []) => {
            await exec(query, params);
          },
          query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
            const rows = await exec(query, params);
            return rows as unknown as T[];
          },
          release: () => reserved.release(),
        };
      },
      close: () => sql.end(),
    });
  } else {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool({
      host,
      port: Number(port),
      user: username,
      password,
      database,
      waitForConnections: true,
      connectionLimit: 5,
      // The application writes UTC DATETIME values, including content deadlines.
      timezone: "Z",
      ...(useSsl ? { ssl: { minVersion: "TLSv1.2", rejectUnauthorized } } : {}),
    });

    return instrumentClient({
      run: async (query, params = []) => {
        // DDL (DROP TABLE, SET …) cannot use prepared statements on MariaDB.
        if (params.length === 0) {
          await pool.query(query);
          return;
        }
        await pool.execute(query, params);
      },
      query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
        const [rows] =
          params.length === 0 ? await pool.query(query) : await pool.execute(query, params);
        return rows as T[];
      },
      execute: async (query, params = []) => {
        const [result] = await pool.execute(query, params);
        return Number((result as { affectedRows?: number }).affectedRows ?? 0);
      },
      transaction: async (fn) => {
        const conn = await pool.getConnection();
        await conn.beginTransaction();
        try {
          const tx = {
            run: async (query: string, params: (string | number | boolean | null)[] = []) => {
              await conn.execute(query, params);
            },
            query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
              const [rows] = await conn.execute(query, params);
              return rows as T[];
            },
            execute: async (query: string, params: (string | number | boolean | null)[] = []) => {
              const [result] = await conn.execute(query, params);
              return Number((result as { affectedRows?: number }).affectedRows ?? 0);
            },
          };
          const value = await fn(tx);
          await conn.commit();
          return value;
        } catch (err) {
          await conn.rollback();
          throw err;
        } finally {
          conn.release();
        }
      },
      reserve: async () => {
        const conn = await pool.getConnection();
        return {
          run: async (query, params = []) => {
            // DDL (DROP TABLE, SET …) cannot use prepared statements on MariaDB.
            if (params.length === 0) {
              await conn.query(query);
              return;
            }
            await conn.execute(query, params);
          },
          query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
            const [rows] =
              params.length === 0 ? await conn.query(query) : await conn.execute(query, params);
            return rows as T[];
          },
          release: () => conn.release(),
        };
      },
      close: async () => pool.end(),
    });
  }
}

/** Reset the cached client (call after install completes). */
export function resetDb() {
  _client = null;
}
