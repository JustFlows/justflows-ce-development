// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsDir } from "../jf-root.js";
import {
  MIGRATION_ORDER,
  isIgnorableMigrationError,
  migrationFileCandidates,
  readMigrationDdl,
  runAllMigrations,
  runMigrationStatements,
  splitSqlStatements,
} from "../run-migrations.js";

describe("MIGRATION_ORDER", () => {
  it("uses the consolidated schema through migration 0012, then tracked migrations", () => {
    expect(MIGRATION_ORDER).toEqual([
      "0012_baseline",
      "0013_public_comments",
      "0014_content_webhooks",
      "0015_theme_designs",
      "0016_user_preferences",
      "0017_password_resets",
      "0018_access_control",
      "0019_device_sessions",
      "0020_email_delivery",
      "0021_trash_retention",
      "0022_email_templates",
      "0023_templates",
      "0024_menu_designer",
      "0025_redirect_manager",
      "0026_api_keys",
      "0027_media_responsive",
      "0028_site_search",
      "0029_search_metrics",
    ]);
  });

  // Each tracked migration after the baseline ships two files: the bare
  // `.sql` for PostgreSQL and `.mysql.sql` shared by MySQL and MariaDB. A
  // dialect-specific `.mariadb.sql` is only added if the DDL must diverge — it
  // never has — so its absence is asserted, not tolerated.
  const TRACKED: { name: string; marker: RegExp }[] = [
    { name: "0013_public_comments", marker: /ALTER TABLE comments ADD COLUMN.*notify/i },
    { name: "0014_content_webhooks", marker: /CREATE TABLE IF NOT EXISTS webhook_endpoints/i },
    { name: "0015_theme_designs", marker: /CREATE TABLE IF NOT EXISTS theme_designs/i },
    { name: "0016_user_preferences", marker: /CREATE TABLE IF NOT EXISTS user_preferences/i },
    { name: "0017_password_resets", marker: /CREATE TABLE IF NOT EXISTS password_resets/i },
    { name: "0018_access_control", marker: /CREATE TABLE IF NOT EXISTS access_roles/i },
    { name: "0019_device_sessions", marker: /CREATE TABLE IF NOT EXISTS user_sessions/i },
    { name: "0020_email_delivery", marker: /CREATE TABLE IF NOT EXISTS email_deliveries/i },
    { name: "0022_email_templates", marker: /CREATE TABLE IF NOT EXISTS email_template_versions/i },
    { name: "0021_trash_retention", marker: /ALTER TABLE content ADD COLUMN.*trashed_at/i },
    { name: "0023_templates", marker: /CREATE TABLE IF NOT EXISTS theme_templates/i },
    { name: "0024_menu_designer", marker: /ALTER TABLE menus ADD COLUMN.*schema_version/i },
    { name: "0026_api_keys", marker: /CREATE TABLE IF NOT EXISTS api_keys/i },
  ];

  for (const { name, marker } of TRACKED) {
    it(`ships ${name} as postgres + shared mysql, no standalone .mariadb.sql`, () => {
      expect(fs.existsSync(path.join(migrationsDir(), `${name}.mariadb.sql`))).toBe(false);
      for (const suffix of [".sql", ".mysql.sql"]) {
        const ddl = fs.readFileSync(path.join(migrationsDir(), `${name}${suffix}`), "utf8");
        const statements = splitSqlStatements(ddl, suffix === ".sql" ? "postgres" : "mysql");
        expect(statements.some((s) => marker.test(s))).toBe(true);
      }
    });

    it(`resolves ${name} for MariaDB to identical DDL (backwards compatible)`, async () => {
      expect(migrationFileCandidates(name, "mariadb")).toEqual([
        `${name}.mariadb.sql`,
        `${name}.mysql.sql`,
        `${name}.sql`,
      ]);
      const mysqlDdl = await readMigrationDdl(name, "mysql");
      const mariadbDdl = await readMigrationDdl(name, "mariadb");
      expect(mariadbDdl).toBe(mysqlDdl);
      expect(marker.test(mariadbDdl ?? "")).toBe(true);
    });
  }

  it("does not rebuild MySQL/MariaDB revisions with a new foreign key or generated unique slot", () => {
    for (const dialect of ["mysql", "mariadb"] as const) {
      const ddl = fs.readFileSync(
        path.join(migrationsDir(), `0012_baseline.${dialect}.sql`),
        "utf8",
      );
      const revisionDdl =
        ddl
          .split("Consolidated migration: 0010_content_revisions")[1]
          ?.split("Consolidated migration: 0011_default_locale_en_us")[0] ?? "";
      const statements = splitSqlStatements(revisionDdl, dialect);
      expect(statements.join("\n")).not.toMatch(/FOREIGN KEY/i);
      expect(statements.join("\n")).not.toMatch(/GENERATED ALWAYS/i);
      expect(statements.join("\n")).not.toMatch(/CREATE UNIQUE INDEX/i);
    }
  });

  it("contains every legacy migration in order for each database dialect", () => {
    const names = [
      "0001_initial",
      "0002_multilingual",
      "0003_css_providers",
      "0004_plugin_data",
      "0005_content_types",
      "0006_session_revocation",
      "0007_totp",
      "0008_audit_log",
      "0009_audit_log_compat",
      "0010_content_revisions",
      "0011_default_locale_en_us",
      "0012_template_parts",
    ];

    for (const suffix of [".sql", ".mysql.sql", ".mariadb.sql"]) {
      const ddl = fs.readFileSync(path.join(migrationsDir(), `0012_baseline${suffix}`), "utf8");
      const positions = names.map((name) => ddl.indexOf(`Consolidated migration: ${name}`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

describe("runAllMigrations", () => {
  it("records a migration and skips it after it has been applied", async () => {
    const ran: string[] = [];
    const applied = new Set<string>();
    const sql = {
      async run(statement: string, params: (string | number | boolean | null)[] = []) {
        ran.push(statement);
        if (statement.startsWith("INSERT INTO _migrations") && params[0] !== undefined) {
          applied.add(String(params[0]));
        }
      },
      async query<T>() {
        return [...applied].map((name) => ({ name })) as T[];
      },
    };

    await runAllMigrations(sql, "postgres", ["0012_baseline"]);
    const firstRunCount = ran.length;
    await runAllMigrations(sql, "postgres", ["0012_baseline"]);

    expect(applied).toEqual(new Set(["0012_baseline"]));
    expect(ran.slice(firstRunCount)).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS _migrations"),
    ]);
  });
});

type FakeDbOptions = {
  driver: "postgres" | "mysql" | "mariadb";
  applied?: string[];
  failOn?: string;
};

/** In-memory stand-in for DbClient covering the bits runAllMigrations touches. */
function makeFakeDb(opts: FakeDbOptions) {
  const applied = new Set(opts.applied ?? []);
  const statements: string[] = [];
  const lockEvents: string[] = [];
  let reservedOpen = 0;

  const run = async (sql: string, params: (string | number | boolean | null)[] = []) => {
    statements.push(sql);
    if (/pg_advisory_lock\(/.test(sql)) return void lockEvents.push("pg-acquire");
    if (/pg_advisory_unlock\(/.test(sql)) return void lockEvents.push("pg-release");
    if (/RELEASE_LOCK\(/.test(sql)) return void lockEvents.push("named-release");
    if (sql.startsWith("INSERT INTO _migrations") && params.length > 0) {
      const name = String(params[0]);
      if (applied.has(name)) {
        throw new Error('duplicate key value violates unique constraint "_migrations_name_key"');
      }
      applied.add(name);
      return;
    }
    if (opts.failOn && sql.includes(opts.failOn)) {
      throw new Error(`boom: ${opts.failOn}`);
    }
  };

  const query = async <T>(sql: string): Promise<T[]> => {
    statements.push(sql);
    if (/GET_LOCK\(/.test(sql)) {
      lockEvents.push("named-acquire");
      return [{ got: 1 }] as T[];
    }
    if (/^SELECT name FROM _migrations/i.test(sql.trim())) {
      return [...applied].map((name) => ({ name })) as T[];
    }
    return [] as T[];
  };

  return {
    applied,
    statements,
    lockEvents,
    get reservedOpen() {
      return reservedOpen;
    },
    run,
    query,
    reserve: async () => {
      reservedOpen += 1;
      return {
        run,
        query,
        release: () => {
          reservedOpen -= 1;
        },
      };
    },
  };
}

describe("runAllMigrations bookkeeping", () => {
  it("records every migration and reports what it applied", async () => {
    const db = makeFakeDb({ driver: "postgres" });

    const result = await runAllMigrations(db, "postgres");

    expect(result.applied).toEqual([...MIGRATION_ORDER]);
    expect(result.skipped).toEqual([]);
    expect(db.applied).toEqual(new Set(MIGRATION_ORDER));
  });

  it("applies zero and skips everything on an unchanged restart", async () => {
    const db = makeFakeDb({ driver: "postgres", applied: [...MIGRATION_ORDER] });

    const result = await runAllMigrations(db, "postgres");

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([...MIGRATION_ORDER]);
  });

  it("applies only missing migrations for a legacy _migrations table holding just 0001", async () => {
    const db = makeFakeDb({ driver: "postgres", applied: ["0001_initial"] });

    const result = await runAllMigrations(db, "postgres");

    expect(result.applied).toEqual([...MIGRATION_ORDER]);
    expect(db.applied).toEqual(new Set(["0001_initial", ...MIGRATION_ORDER]));
  });

  it("cannot skip later migrations because 0001 was already recorded", async () => {
    const db = makeFakeDb({ driver: "postgres", applied: ["0001_initial"] });

    const result = await runAllMigrations(db, "postgres");

    expect(result.applied).toContain("0014_content_webhooks");
  });

  it("serializes a second run behind the first by reading recorded migrations", async () => {
    const db = makeFakeDb({ driver: "postgres" });

    await runAllMigrations(db, "postgres");
    const second = await runAllMigrations(db, "postgres");

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([...MIGRATION_ORDER]);
  });
});

describe("runAllMigrations locking", () => {
  it("takes and releases a PostgreSQL advisory lock around the run", async () => {
    const db = makeFakeDb({ driver: "postgres" });

    await runAllMigrations(db, "postgres");

    expect(db.lockEvents).toEqual(["pg-acquire", "pg-release"]);
    expect(db.reservedOpen).toBe(0);
  });

  it("takes and releases a named lock on MySQL/MariaDB", async () => {
    const db = makeFakeDb({ driver: "mariadb" });

    await runAllMigrations(db, "mariadb");

    expect(db.lockEvents).toEqual(["named-acquire", "named-release"]);
    expect(db.reservedOpen).toBe(0);
  });

  it("releases the lock and the connection even when a migration fails", async () => {
    const db = makeFakeDb({ driver: "postgres", failOn: "webhook_deliveries" });

    await expect(runAllMigrations(db, "postgres")).rejects.toThrow(/webhook_deliveries/);

    expect(db.lockEvents).toEqual(["pg-acquire", "pg-release"]);
    expect(db.reservedOpen).toBe(0);
    expect(db.applied.has("0014_content_webhooks")).toBe(false);
  });

  it("runs unlocked when the runner cannot reserve a connection", async () => {
    const ran: string[] = [];
    const applied = new Set<string>();
    const sql = {
      async run(statement: string, params: (string | number | boolean | null)[] = []) {
        ran.push(statement);
        if (statement.startsWith("INSERT INTO _migrations") && params[0] !== undefined) {
          applied.add(String(params[0]));
        }
      },
      async query<T>() {
        return [...applied].map((name) => ({ name })) as T[];
      },
    };

    const result = await runAllMigrations(sql, "postgres", ["0013_public_comments"]);

    expect(result.applied).toEqual(["0013_public_comments"]);
    expect(ran.some((s) => /pg_advisory_lock/.test(s))).toBe(false);
  });
});

describe("isIgnorableMigrationError", () => {
  it("ignores MySQL/MariaDB DROP INDEX when the key is already gone", () => {
    const err = Object.assign(
      new Error("Can't DROP INDEX `uq_content_slug`; check that it exists"),
      {
        code: "ER_CANT_DROP_FIELD_OR_KEY",
        errno: 1091,
      },
    );
    expect(isIgnorableMigrationError(err)).toBe(true);
  });

  it("does not ignore missing-table errors", () => {
    expect(
      isIgnorableMigrationError(new Error("Table 'justflows.content_types' doesn't exist")),
    ).toBe(false);
  });

  it("ignores a PostgreSQL migration name that was already recorded", () => {
    expect(
      isIgnorableMigrationError(
        new Error('duplicate key value violates unique constraint "_migrations_name_key"'),
      ),
    ).toBe(true);
  });
});

describe("runMigrationStatements", () => {
  it("continues past a missing unique index on MySQL re-runs", async () => {
    const ran: string[] = [];
    await runMigrationStatements(
      {
        async run(sql) {
          ran.push(sql);
          if (sql.includes("DROP INDEX")) {
            throw Object.assign(
              new Error("Can't DROP INDEX `uq_content_slug`; check that it exists"),
              {
                code: "ER_CANT_DROP_FIELD_OR_KEY",
              },
            );
          }
        },
      },
      "ALTER TABLE content DROP INDEX uq_content_slug;\nALTER TABLE content ADD UNIQUE KEY uq_content_slug_locale (site_id, type, slug(200), locale);",
      "mariadb",
    );
    expect(ran).toHaveLength(2);
  });

  it("retries DROP INDEX without IF EXISTS on MySQL 8", async () => {
    const ran: string[] = [];
    await runMigrationStatements(
      {
        async run(sql) {
          ran.push(sql);
          if (/\bIF EXISTS\b/i.test(sql)) {
            throw new Error("You have an error in your SQL syntax near 'IF EXISTS'");
          }
        },
      },
      "ALTER TABLE content DROP INDEX IF EXISTS uq_content_slug;",
      "mysql",
    );
    expect(ran).toEqual([
      "ALTER TABLE content DROP INDEX IF EXISTS uq_content_slug",
      "ALTER TABLE content DROP INDEX uq_content_slug",
    ]);
  });
});
