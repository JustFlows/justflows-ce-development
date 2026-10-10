// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationsDir } from "../../../src/lib/runtime/jf-root.js";
import {
  MIGRATION_ORDER,
  baselineSections,
  isIgnorableMigrationError,
  migrationFileCandidates,
  readMigrationDdl,
  runAllMigrations,
  runMigrationStatements,
  splitSqlStatements,
} from "../../../src/lib/database/run-migrations.js";

const LEGACY_MIGRATIONS = [
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
  "0030_content_scheduling",
  "0031_comment_spam",
  "0032_comment_trash_repair",
  "0033_spam_term_source",
  "0034_user_role_text",
  "0035_user_additional_roles",
  "0036_ai_byok",
];

describe("MIGRATION_ORDER", () => {
  it("uses the sites charset and collation for the storage lock foreign key on MySQL and MariaDB", async () => {
    for (const driver of ["mysql", "mariadb"] as const) {
      const baseline = await readMigrationDdl("0036_baseline", driver);
      const locks = await readMigrationDdl("0043_storage_quota_locks", driver);
      if (baseline === null || locks === null) {
        throw new Error(`Missing baseline or storage lock migration for ${driver}`);
      }
      const sites = baseline.match(/CREATE TABLE IF NOT EXISTS sites \([\s\S]*?;/)?.[0];
      const charset = sites?.match(/DEFAULT CHARSET=\w+ COLLATE=\w+/)?.[0];
      expect(charset).toBe("DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
      expect(locks).toContain(charset!);
    }
  });

  it("uses the consolidated schema through migration 0036", () => {
    expect(MIGRATION_ORDER).toEqual(["0036_baseline", "0037_tenancy", "0038_quota_limits", "0039_custom_domains", "0040_security_hardening", "0041_domain_provider_attachment", "0042_private_files", "0043_storage_quota_locks", "0044_workspace_owner", "0045_account_pages", "0046_content_type_cache_control"]);
  });

  it("contains every legacy migration in order for each database dialect", () => {
    for (const suffix of [".sql", ".mysql.sql", ".mariadb.sql"]) {
      const ddl = fs.readFileSync(path.join(migrationsDir(), `0036_baseline${suffix}`), "utf8");
      expect(baselineSections(ddl).map((s) => s.name)).toEqual(LEGACY_MIGRATIONS);
    }
  });

  // Folded migrations stay addressable by name, so a test can apply one on its own.
  const TRACKED: { name: string; marker: RegExp }[] = [
    { name: "0013_public_comments", marker: /ALTER TABLE comments ADD COLUMN.*notify/i },
    { name: "0014_content_webhooks", marker: /CREATE TABLE IF NOT EXISTS webhook_endpoints/i },
    { name: "0015_theme_designs", marker: /CREATE TABLE IF NOT EXISTS theme_designs/i },
    { name: "0016_user_preferences", marker: /CREATE TABLE IF NOT EXISTS user_preferences/i },
    { name: "0017_password_resets", marker: /CREATE TABLE IF NOT EXISTS password_resets/i },
    { name: "0018_access_control", marker: /CREATE TABLE IF NOT EXISTS access_roles/i },
    { name: "0019_device_sessions", marker: /CREATE TABLE IF NOT EXISTS user_sessions/i },
    { name: "0020_email_delivery", marker: /CREATE TABLE IF NOT EXISTS email_deliveries/i },
    { name: "0021_trash_retention", marker: /ALTER TABLE content ADD COLUMN.*trashed_at/i },
    { name: "0022_email_templates", marker: /CREATE TABLE IF NOT EXISTS email_template_versions/i },
    { name: "0023_templates", marker: /CREATE TABLE IF NOT EXISTS theme_templates/i },
    { name: "0024_menu_designer", marker: /ALTER TABLE menus ADD COLUMN.*schema_version/i },
    { name: "0026_api_keys", marker: /CREATE TABLE IF NOT EXISTS api_keys/i },
    { name: "0034_user_role_text", marker: /varchar\(32\)/i },
    {
      name: "0035_user_additional_roles",
      marker: /CREATE TABLE IF NOT EXISTS user_additional_roles/i,
    },
    { name: "0036_ai_byok", marker: /CREATE TABLE IF NOT EXISTS oauth_tokens/i },
  ];

  for (const { name, marker } of TRACKED) {
    it(`resolves ${name} from the baseline for every dialect`, async () => {
      for (const driver of ["postgres", "mysql", "mariadb"] as const) {
        const ddl = await readMigrationDdl(name, driver);
        expect(splitSqlStatements(ddl ?? "", driver).some((s) => marker.test(s))).toBe(true);
      }
      // MariaDB shared the MySQL DDL for every migration after 0012.
      expect(await readMigrationDdl(name, "mariadb")).toBe(await readMigrationDdl(name, "mysql"));
    });
  }

  it("resolves MariaDB through its own file, then MySQL, then the bare file", () => {
    expect(migrationFileCandidates("0037_example", "mariadb")).toEqual([
      "0037_example.mariadb.sql",
      "0037_example.mysql.sql",
      "0037_example.sql",
    ]);
  });

  it("does not rebuild MySQL/MariaDB revisions with a new foreign key or generated unique slot", async () => {
    for (const dialect of ["mysql", "mariadb"] as const) {
      const statements = splitSqlStatements(
        (await readMigrationDdl("0010_content_revisions", dialect)) ?? "",
        dialect,
      );
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.join("\n")).not.toMatch(/FOREIGN KEY/i);
      expect(statements.join("\n")).not.toMatch(/GENERATED ALWAYS/i);
      expect(statements.join("\n")).not.toMatch(/CREATE UNIQUE INDEX/i);
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

    await runAllMigrations(sql, "postgres", ["0036_baseline"]);
    const firstRunCount = ran.length;
    await runAllMigrations(sql, "postgres", ["0036_baseline"]);

    expect(applied).toEqual(new Set(["0036_baseline"]));
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

    await runAllMigrations(db, "postgres");

    expect(db.statements.some((s) => s.includes("CREATE TYPE user_role"))).toBe(false);
    expect(db.statements.some((s) => s.includes("webhook_endpoints"))).toBe(true);
  });

  it("runs the whole baseline on a fresh database", async () => {
    const db = makeFakeDb({ driver: "postgres" });

    await runAllMigrations(db, "postgres");

    expect(db.statements.some((s) => s.includes("CREATE TYPE user_role"))).toBe(true);
    expect(db.statements.some((s) => s.includes("oauth_tokens"))).toBe(true);
  });

  for (const driver of ["postgres", "mysql", "mariadb"] as const) {
    it(`upgrades a ${driver} site on 0012_baseline with only 0013 onwards`, async () => {
      const db = makeFakeDb({ driver, applied: ["0012_baseline"] });

      const result = await runAllMigrations(db, driver);

      expect(result.applied).toEqual(["0036_baseline", "0037_tenancy", "0038_quota_limits", "0039_custom_domains", "0040_security_hardening", "0041_domain_provider_attachment", "0042_private_files", "0043_storage_quota_locks", "0044_workspace_owner", "0045_account_pages", "0046_content_type_cache_control"]);
      expect(db.statements.some((s) => /CREATE TABLE IF NOT EXISTS template_parts/i.test(s))).toBe(
        false,
      );
      expect(db.statements.some((s) => s.includes("webhook_endpoints"))).toBe(true);
    });
  }

  it("does not replay 0001 after 0034 dropped the user_role enum", async () => {
    const applied = ["0012_baseline", ...LEGACY_MIGRATIONS.slice(12, -1)];
    const db = makeFakeDb({ driver: "postgres", applied });

    await runAllMigrations(db, "postgres");

    expect(db.statements.some((s) => s.includes("CREATE TYPE user_role"))).toBe(false);
    expect(db.statements.some((s) => s.includes("webhook_endpoints"))).toBe(false);
    expect(db.statements.some((s) => s.includes("oauth_tokens"))).toBe(true);
    expect(db.applied.has("0036_baseline")).toBe(true);
  });

  it("only records the baseline on a site that already has every folded migration", async () => {
    const db = makeFakeDb({
      driver: "mysql",
      applied: ["0012_baseline", ...LEGACY_MIGRATIONS.slice(12)],
    });

    const result = await runAllMigrations(db, "mysql");

    expect(result.applied).toEqual(["0036_baseline", "0037_tenancy", "0038_quota_limits", "0039_custom_domains", "0040_security_hardening", "0041_domain_provider_attachment", "0042_private_files", "0043_storage_quota_locks", "0044_workspace_owner", "0045_account_pages", "0046_content_type_cache_control"]);
    const schemaChanges = db.statements.filter(
      (s) => /^(CREATE|ALTER|DROP|UPDATE|INSERT)\b/i.test(s.trim()) && !s.includes("_migrations"),
    );
    expect(schemaChanges.some((s) => s.includes("webhook_endpoints"))).toBe(false);
    expect(schemaChanges.some((s) => s.includes("tenants"))).toBe(true);
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
    expect(db.applied.has("0036_baseline")).toBe(false);
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
