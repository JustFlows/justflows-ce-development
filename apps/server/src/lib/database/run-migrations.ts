import fs from "node:fs/promises";
import path from "node:path";
import { migrationsDir } from "../runtime/jf-root.js";

export const MIGRATION_ORDER = ["0036_baseline", "0037_tenancy", "0038_quota_limits", "0039_custom_domains", "0040_security_hardening", "0041_domain_provider_attachment", "0042_private_files", "0043_storage_quota_locks"] as const;

export type DbDriver = "postgres" | "mysql" | "mariadb";

/** Outcome of a migration run, surfaced to the admin API and the CLI. */
export interface MigrationResult {
  /** Migrations whose DDL ran during this call. */
  applied: string[];
  /** Migrations already recorded, or shipped without DDL for this dialect. */
  skipped: string[];
}

interface SqlRunner {
  run(sql: string, params?: (string | number | boolean | null)[]): Promise<void>;
}

interface StatementRunner extends SqlRunner {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: (string | number | boolean | null)[],
  ): Promise<T[]>;
}

/** A connection pinned for the duration of a migration run. */
interface ReservedRunner extends StatementRunner {
  release(): void;
}

interface MigrationRunner extends StatementRunner {
  /**
   * Optional: pin one connection so a cross-process migration lock can be held
   * for the whole run. Callers without a pool (fresh install, tests) omit it.
   */
  reserve?(): Promise<ReservedRunner>;
}

// Fixed keys so every booting worker contends for the same lock.
const PG_ADVISORY_LOCK_KEY = 941_000_055;
const NAMED_LOCK = "justflows:migrations";
const NAMED_LOCK_TIMEOUT_SECONDS = 60;

/** Split SQL into independently executable statements. */
export function splitSqlStatements(ddl: string, _driver: DbDriver): string[] {
  const withoutLineComments = ddl
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      // sql.run may use a pool, so transaction-control statements could run on
      // different connections. They also leave PostgreSQL transactions aborted
      // after an idempotent duplicate-object error that the runner can ignore.
      if (/^BEGIN$/i.test(s)) return false;
      if (/^COMMIT$/i.test(s)) return false;
      return true;
    });
}

/** Idempotent migration errors we can safely ignore on re-run. */
export function isIgnorableMigrationError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  // MySQL/MariaDB 1091: DROP INDEX / DROP COLUMN when the object is already gone.
  if (code === "ER_CANT_DROP_FIELD_OR_KEY") return true;
  if (msg.includes("already exists")) return true;
  if (msg.includes("duplicate column")) return true;
  if (msg.includes("duplicate key name")) return true;
  if (msg.includes("duplicate foreign key")) return true;
  if (msg.includes("duplicate check constraint")) return true;
  if (msg.includes("duplicate key value")) return true;
  if (msg.includes("duplicate entry")) return true;
  if (msg.includes("check that it exists")) return true;
  if (msg.includes("can't drop index")) return true;
  if (msg.includes("can't drop foreign key")) return true;
  return false;
}

/**
 * Candidate files for a migration, in precedence order.
 *
 * PostgreSQL reads the bare `${name}.sql`. MySQL reads `${name}.mysql.sql` and
 * falls back to the bare file. MariaDB reads `${name}.mariadb.sql`, then the
 * MySQL file, then the bare file — the DDL these two dialects need has been
 * byte-for-byte identical in practice, so a migration only ships a separate
 * `.mariadb.sql` on the rare occasion it genuinely diverges. This keeps three
 * files per migration from becoming the default.
 */
export function migrationFileCandidates(name: string, driver: DbDriver): string[] {
  if (driver === "postgres") return [`${name}.sql`];
  if (driver === "mariadb") return [`${name}.mariadb.sql`, `${name}.mysql.sql`, `${name}.sql`];
  return [`${name}.mysql.sql`, `${name}.sql`];
}

async function readMigrationFile(name: string, driver: DbDriver): Promise<string | null> {
  const dir = migrationsDir();
  for (const candidate of migrationFileCandidates(name, driver)) {
    try {
      return await fs.readFile(path.join(dir, candidate), "utf-8");
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * DDL for a migration: its own file, or — for a migration folded into a
 * baseline — that migration's section of the baseline.
 */
export async function readMigrationDdl(name: string, driver: DbDriver): Promise<string | null> {
  const ddl = await readMigrationFile(name, driver);
  if (ddl !== null) return ddl;
  for (const baseline of MIGRATION_ORDER.filter(isBaseline)) {
    const baselineDdl = await readMigrationFile(baseline, driver);
    const section = baselineDdl
      ? baselineSections(baselineDdl).find((s) => s.name === name)
      : undefined;
    if (section) return section.ddl;
  }
  return null;
}

/** A baseline folds the full ordered history up to its number into one file. */
function isBaseline(name: string): boolean {
  return /^\d{4}_baseline$/.test(name);
}

function migrationNumber(name: string): number {
  return Number.parseInt(name.slice(0, 4), 10);
}

const SECTION_MARKER = /^-- Consolidated migration: (\d{4}_\w+)[ \t]*$/gm;

/** Split a baseline into the original migrations it consolidates, in order. */
export function baselineSections(ddl: string): { name: string; ddl: string }[] {
  const markers = [...ddl.matchAll(SECTION_MARKER)];
  return markers.map((match, i) => ({
    name: match[1] ?? "",
    ddl: ddl.slice(match.index + match[0].length, markers[i + 1]?.index ?? ddl.length),
  }));
}

/**
 * Whether a database already has a consolidated migration: it was recorded
 * under its own name, or under an older baseline that already contained it.
 */
function sectionRecorded(name: string, recorded: ReadonlySet<string>): boolean {
  if (recorded.has(name)) return true;
  return [...recorded].some(
    (entry) => isBaseline(entry) && migrationNumber(entry) >= migrationNumber(name),
  );
}

function withoutIfExists(sql: string): string {
  return sql.replace(/\s+IF\s+EXISTS\b/gi, "");
}

export async function runMigrationStatements(
  sql: SqlRunner,
  ddl: string,
  driver: DbDriver,
): Promise<void> {
  for (const stmt of splitSqlStatements(ddl, driver)) {
    try {
      await sql.run(stmt);
    } catch (err: unknown) {
      if (isIgnorableMigrationError(err)) continue;
      // MySQL 8 rejects DROP INDEX IF EXISTS; retry the plain DROP, then ignore 1091.
      if (driver !== "postgres" && /\bif\s+exists\b/i.test(stmt)) {
        try {
          await sql.run(withoutIfExists(stmt));
          continue;
        } catch (retryErr: unknown) {
          if (isIgnorableMigrationError(retryErr)) continue;
          throw retryErr;
        }
      }
      throw err;
    }
  }
}

function createMigrationsTableSql(driver: DbDriver): string {
  return driver === "postgres"
    ? `CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    : `CREATE TABLE IF NOT EXISTS _migrations (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

async function acquireMigrationLock(conn: ReservedRunner, driver: DbDriver): Promise<void> {
  if (driver === "postgres") {
    // Blocks until the other worker's run finishes; released in the finally below.
    await conn.run("SELECT pg_advisory_lock(?)", [PG_ADVISORY_LOCK_KEY]);
    return;
  }
  const rows = await conn.query<{ got: number | null }>("SELECT GET_LOCK(?, ?) AS got", [
    NAMED_LOCK,
    NAMED_LOCK_TIMEOUT_SECONDS,
  ]);
  if (!rows[0] || Number(rows[0].got) !== 1) {
    throw new Error(
      `Could not acquire migration lock "${NAMED_LOCK}" within ${NAMED_LOCK_TIMEOUT_SECONDS}s — another process may be stuck mid-migration`,
    );
  }
}

async function releaseMigrationLock(conn: ReservedRunner, driver: DbDriver): Promise<void> {
  try {
    if (driver === "postgres") {
      await conn.run("SELECT pg_advisory_unlock(?)", [PG_ADVISORY_LOCK_KEY]);
    } else {
      await conn.run("SELECT RELEASE_LOCK(?)", [NAMED_LOCK]);
    }
  } catch {
    // Best effort: the lock also clears when the session ends.
  }
}

async function applyMigrations(
  sql: StatementRunner,
  driver: DbDriver,
  names: readonly string[],
): Promise<MigrationResult> {
  await sql.run(createMigrationsTableSql(driver));

  // Legacy databases carry a `_migrations` table with only `0001_initial`.
  // Reading it (rather than assuming nothing is applied) is what stops
  // PostgreSQL from re-running `0001` and aborting before later migrations.
  const recordedRows = await sql.query<{ name: string }>("SELECT name FROM _migrations");
  const recorded = new Set(recordedRows.map((row) => String(row.name)));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    if (recorded.has(name)) {
      skipped.push(name);
      continue;
    }
    const ddl = await readMigrationDdl(name, driver);
    if (!ddl) {
      // Nothing shipped for this dialect — treat as satisfied so the run finishes.
      skipped.push(name);
      continue;
    }
    // The shipped DDL is deliberately idempotent (IF NOT EXISTS plus ignorable
    // duplicate-object errors), so a failed run re-applies safely on next boot.
    // That is the recovery path for MySQL/MariaDB, whose DDL auto-commits.
    if (isBaseline(name)) {
      // Upgrades run only the history this database is missing. Replaying
      // applied sections is not safe: 0001 would recreate the user_role enum
      // that 0034 dropped.
      for (const section of baselineSections(ddl)) {
        if (sectionRecorded(section.name, recorded)) continue;
        await runMigrationStatements(sql, section.ddl, driver);
      }
    } else {
      await runMigrationStatements(sql, ddl, driver);
    }
    try {
      // Record only after every statement succeeded.
      await sql.run("INSERT INTO _migrations (name) VALUES (?)", [name]);
    } catch (err: unknown) {
      // A concurrent run may have recorded the same migration first.
      if (!isIgnorableMigrationError(err)) throw err;
    }
    applied.push(name);
  }

  return { applied, skipped };
}

export async function runAllMigrations(
  sql: MigrationRunner,
  driver: DbDriver,
  names: readonly string[] = MIGRATION_ORDER,
): Promise<MigrationResult> {
  // Serialize concurrently booting workers so two processes never run the same
  // DDL at once. Needs a pinned connection to hold the lock; callers without a
  // pool (fresh install, tests) run unlocked, which is safe because they are
  // single-connection and the only writer.
  const reserved = typeof sql.reserve === "function" ? await sql.reserve() : null;
  if (!reserved) {
    return applyMigrations(sql, driver, names);
  }

  try {
    await acquireMigrationLock(reserved, driver);
    return await applyMigrations(reserved, driver, names);
  } finally {
    await releaseMigrationLock(reserved, driver);
    reserved.release();
  }
}

/** Apply shipped schema updates for an already-installed site (zip/core update). */
export async function applyPendingMigrations(): Promise<MigrationResult> {
  const { getDb } = await import("./db.js");
  const db = await getDb();
  const driver = process.env.DB_DRIVER as DbDriver | undefined;
  if (!driver) return { applied: [], skipped: [] };
  return runAllMigrations(db, driver);
}
