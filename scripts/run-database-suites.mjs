#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Runs every real-database integration suite against one database server
 * (justflows-ce#310), in CI and locally.
 *
 * Each suite only runs when its own flag is set and `DB_NAME` is its own
 * throwaway database, so it can never touch a real site. This script creates
 * those databases (dropping any left from an earlier run), runs each suite
 * with its flag, and fails when a suite fails or runs no tests, so a suite
 * that silently skips is caught.
 *
 *   DB_DRIVER=postgres|mysql|mariadb DB_HOST=127.0.0.1 DB_PORT=5432 \
 *   DB_USER=… DB_PASSWORD=… [DB_ADMIN_USER=… DB_ADMIN_PASSWORD=…] \
 *   node scripts/run-database-suites.mjs [suite-name …]
 *
 * The admin account creates the databases; for MySQL and MariaDB it also
 * grants `DB_USER` access to them. It defaults to `DB_USER`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverRequire = createRequire(path.join(root, "apps/server/package.json"));

/** Builder 2.0 suites, run together on one database (justflows-ce#301, #302, #304, #310). */
const BUILDER_FILES = [
  "tests/integration/database/block-references-db.integration.test.ts",
  "tests/integration/database/builder-concurrency-db.integration.test.ts",
  "tests/integration/database/builder-journeys-db.integration.test.ts",
];

/** [name, flag, database, test file]. Database names are fixed by each suite's own guard. */
export const SUITES = [
  ["security-migrations", "SECURITY_TEST_DATABASE", "security_test", "tests/integration/database/security-migrations-db.integration.test.ts"],
  ["job-queue", "JOB_QUEUE_TEST_DATABASE", "job_queue_test", "tests/integration/database/job-queue-db.integration.test.ts"],
  ["plugin-rows", "PLUGIN_ROWS_TEST_DATABASE", "plugin_rows_test", "tests/integration/database/plugin-rows-db.integration.test.ts"],
  ["plugin-schema", "PLUGIN_SCHEMA_TEST_DATABASE", "plugin_schema_test", "tests/integration/database/plugin-schema-upgrade-db.integration.test.ts"],
  ["builder", "BUILDER_TEST_DATABASE", "builder_test", ""],
  ["builder-upgrade", "BUILDER_UPGRADE_TEST_DATABASE", "builder_upgrade_test", "tests/integration/database/builder-upgrade-db.integration.test.ts"],
  ["content-scheduling", "SCHEDULE_TEST_DATABASE", "schedule_test", "tests/integration/database/content-scheduling-db.integration.test.ts"],
  ["content-visibility", "VISIBILITY_TEST_DATABASE", "visibility_test", "tests/integration/database/content-visibility-db.integration.test.ts"],
  ["search", "SEARCH_TEST_DATABASE", "search_test", "tests/integration/database/search-db.integration.test.ts"],
  ["agent-isolation", "AGENT_ISOLATION_TEST_DATABASE", "isolation_test", "tests/integration/database/agent-isolation-db.integration.test.ts"],
  ["ai-byok", "AI_TEST_DATABASE", "ai_test", "tests/integration/database/ai-byok-migration.integration.test.ts"],
];

const env = process.env;
const driver = env.DB_DRIVER;
if (!["postgres", "mysql", "mariadb"].includes(driver ?? "")) {
  console.error("Set DB_DRIVER to postgres, mysql or mariadb.");
  process.exit(2);
}
const host = env.DB_HOST ?? "127.0.0.1";
const port = Number(env.DB_PORT ?? (driver === "postgres" ? 5432 : 3306));
const user = env.DB_USER;
const password = env.DB_PASSWORD ?? "";
const adminUser = env.DB_ADMIN_USER ?? user;
const adminPassword = env.DB_ADMIN_PASSWORD ?? password;

const wanted = process.argv.slice(2);
const suites = wanted.length ? SUITES.filter(([name]) => wanted.includes(name)) : SUITES;

async function createDatabases(names) {
  if (driver === "postgres") {
    const postgres = serverRequire("postgres");
    const sql = postgres({ host, port, user: adminUser, password: adminPassword, database: "postgres", max: 1, onnotice: () => {} });
    for (const name of names) {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await sql.unsafe(`CREATE DATABASE ${name} OWNER ${user}`);
    }
    await sql.end();
    return;
  }
  const mysql = serverRequire("mysql2/promise");
  const conn = await mysql.createConnection({ host, port, user: adminUser, password: adminPassword });
  for (const name of names) {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (user !== adminUser) await conn.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@'%'`, [user]);
  }
  await conn.end();
}

await createDatabases([...new Set(suites.map(([, , db]) => db))]);

const failures = [];
for (const [name, flag, database, file] of suites) {
  /** The builder suites share one flag and database. */
  const files = name === "builder" ? BUILDER_FILES.filter((f) => existsSync(path.join(root, "apps/server", f))) : [file];
  console.log(`\n▶ ${name} on ${driver} (${database})`);
  const run = spawnSync("pnpm", ["--filter", "@justflows/server", "exec", "vitest", "run", ...files], {
    cwd: root,
    env: { ...env, [flag]: "1", DB_NAME: database, DB_DRIVER: driver === "mariadb" ? "mariadb" : driver },
    encoding: "utf8",
  });
  /** CI prints colours; the counts are read from the plain text. */
  const output = `${run.stdout}${run.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  process.stdout.write(output.split("\n").filter((line) => /Test Files|Tests|FAIL|×/.test(line)).join("\n") + "\n");
  const passed = Number(/Tests\s+(\d+) passed/.exec(output)?.[1] ?? 0);
  if (run.status !== 0) failures.push(`${name}: failed`);
  else if (passed === 0) failures.push(`${name}: ran no tests (check the flag and DB_NAME guard)`);
}

if (failures.length) {
  console.error(`\n${failures.length} suite(s) did not pass on ${driver}:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll ${suites.length} database suites passed on ${driver}.`);
