import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { markInstalled } from "../lib/install-state.js";
import { resetDb } from "../lib/db.js";
import { runAllMigrations } from "../lib/run-migrations.js";
import { isInstalled } from "../middleware/install-guard.js";
import { hashPassword } from "../lib/password.js";
import {
  installToken,
  installTokenFileExists,
  installTokenRequired,
  isLoopbackAddress,
  tokenMatches,
} from "../lib/install-token.js";
import { getJustflowsVersion } from "../lib/version.js";
import { SiteUrlSchema } from "../lib/site-url.js";
import { freshInstallSiteSettings, parseInstallLocale, siteSettingsInsertSql } from "../lib/install-defaults.js";
import { sendInstallDetailsMail } from "../lib/install-mail.js";

const router = Router();


const Schema = z.object({
  db: z.object({
    driver: z.enum(["postgres", "mysql", "mariadb"]),
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string(),
  }),
  token: z.string().optional(),
  site: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    url: SiteUrlSchema,
    locale: z.string().min(2).max(20).optional(),
  }),
  account: z.object({
    email: z.string().email(),
    username: z.string().min(2).max(60),
    displayName: z.string().min(1),
    password: z.string().min(12, "Password must be at least 12 characters").max(1024),
    emailDetails: z.boolean().optional(),
  }),
});

function sseEvent(type: "step" | "done" | "error", message: string): string {
  return `data: ${JSON.stringify({ type, message })}\n\n`;
}

/** Emit a single error event and close the stream. */
function emit0(res: { setHeader(k: string, v: string): unknown; write(s: string): unknown; end(): unknown }, message: string): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.write(sseEvent("error", message));
  res.end();
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

interface DbClient {
  run(sql: string, params?: (string | number | boolean | null)[]): Promise<void>;
  query<T = Record<string, unknown>>(
    sql: string,
    params?: (string | number | boolean | null)[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

async function connectDb(driver: "postgres" | "mysql" | "mariadb", url: string): Promise<DbClient> {
  if (driver === "postgres") {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 1, connect_timeout: 8 });
    await sql`SELECT 1`;
    return {
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
      close: () => sql.end(),
    };
  }

  const mysql = await import("mysql2/promise");
  const parsed = new URL(url);
  const conn = await mysql.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    connectTimeout: 8000,
  });
  await conn.query("SELECT 1");
  return {
    run: async (query, params = []) => {
      await conn.execute(query, params as (string | number | boolean | null)[]);
    },
    query: async <T>(query: string, params: (string | number | boolean | null)[] = []) => {
      const [rows] = await conn.execute(query, params as (string | number | boolean | null)[]);
      return rows as T[];
    },
    close: async () => conn.end(),
  };
}

router.get("/status", (req, res) => {
  const installed = isInstalled();
  // Mint on this request so `pnpm dev` (no root server.js) still writes the
  // file before the owner is asked to paste it.
  if (!installed && installTokenRequired()) {
    installToken();
  }
  // Deliberately does not include the token. It reports only whether one is
  // needed and where to find it, so the wizard can show the right instructions.
  res.json({
    installed,
    tokenRequired: !installed && installTokenRequired() && !isLoopbackAddress(req.ip),
    tokenFile: installTokenFileExists() ? "install-token/TOKEN.txt" : null,
  });
});

router.get("/complete", (_req, res) => {
  if (!isInstalled()) {
    res.status(400).json({ error: "Not installed" });
    return;
  }
  res.cookie("jf_installed", "1", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

router.post("/", async (req, res) => {
  if (isInstalled()) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(sseEvent("error", "Already installed"));
    res.end();
    return;
  }

  const body = Schema.safeParse(req.body);
  if (!body.success) {
    const msg = body.error.issues[0]?.message ?? "Invalid input";
    res.setHeader("Content-Type", "text/event-stream");
    res.write(sseEvent("error", msg));
    res.end();
    return;
  }

  if (installTokenRequired() && !isLoopbackAddress(req.ip)) {
    if (!tokenMatches(body.data.token)) {
      emit0(
        res,
        installTokenFileExists()
          ? "That installation token is not correct. Open install-token/TOKEN.txt in your site's " +
              "folder (via FTP or your host's File Manager) and copy the token from there."
          : "An installation token is required. Restart the app to generate one — it is written to " +
              "install-token/TOKEN.txt in your site's folder and printed to the server log.",
      );
      return;
    }
  }

  const { db, site, account } = body.data;
  const localeParsed = parseInstallLocale(site.locale);
  if (!localeParsed.ok) {
    emit0(res, localeParsed.error);
    return;
  }
  const installLocale = localeParsed.meta;
  const encodedUser = encodeURIComponent(db.username);
  const encodedPass = encodeURIComponent(db.password);
  // Host and database name were interpolated raw, unlike the credentials, so a
  // value containing "@" or "?" could rewrite the rest of the connection string.
  const encodedHost = encodeURIComponent(db.host);
  const encodedName = encodeURIComponent(db.database);
  const dbUrl = `${db.driver}://${encodedUser}:${encodedPass}@${encodedHost}:${db.port}/${encodedName}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const emit = (type: "step" | "done" | "error", message: string) => {
    res.write(sseEvent(type, message));
    const flushable = res as typeof res & { flush?: () => void };
    flushable.flush?.();
  };

  try {
    emit("step", "Connecting to database…");
    let sql: DbClient;
    try {
      sql = await connectDb(db.driver, dbUrl);
    } catch (e) {
      // Deliberately uniform: reporting the driver's own message let an
      // unauthenticated caller tell "connection refused" from "authentication
      // failed" and map internal hosts through the install form.
      console.error("[justflows] install: database connection failed:", e);
      emit(
        "error",
        `Cannot connect to the ${db.driver} database. Check the hostname, port, database name, username and password.`,
      );
      res.end();
      return;
    }

    emit("step", "Setting up database tables…");
    try {
      await runAllMigrations(sql, db.driver);
    } catch (e) {
      // Same reasoning as the connection failure above: this caller is
      // unauthenticated, and a driver error names the schema, the column and
      // sometimes the host. The detail goes to the log.
      console.error("[justflows] install: migrations failed:", e);
      emit("error", "Could not create the database tables. Check that the database user may create tables, then try again.");
      res.end();
      return;
    }

    emit("step", "Creating your site…");
    const siteId = randomUUID();
    try {
      await sql.run(
        `INSERT INTO sites (id, name, url, description, active, installed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [siteId, site.name, site.url, site.description ?? null, true, now(), now(), now()],
      );
    } catch (e) {
      console.error("[justflows] install: site row failed:", e);
      emit("error", "Could not create the site record. Check the server log for details.");
      res.end();
      return;
    }

    emit("step", "Creating admin account…");
    const passwordHash = await hashPassword(account.password);
    const userId = randomUUID();
    try {
      await sql.run(
        `INSERT INTO users (id, site_id, email, username, display_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          siteId,
          account.email,
          account.username,
          account.displayName,
          passwordHash,
          "administrator",
          now(),
          now(),
        ],
      );
    } catch (e) {
      console.error("[justflows] install: admin account failed:", e);
      emit("error", "Could not create the administrator account. Check the server log for details.");
      res.end();
      return;
    }

    emit("step", "Saving site settings…");
    const defaultSettings = freshInstallSiteSettings(account.email);
    const settingsSql = siteSettingsInsertSql(db.driver);
    try {
      for (const [key, value] of defaultSettings) {
        await sql.run(settingsSql, [randomUUID(), siteId, key, JSON.stringify(value), now()]);
      }
    } catch (e) {
      console.error("[justflows] install: site settings failed:", e);
      emit("error", "Could not save the default site settings. Check the server log for details.");
      res.end();
      return;
    }

    emit("step", "Setting up languages…");
    const langId = randomUUID();
    const isDefault = db.driver === "postgres" ? true : 1;
    try {
      await sql.run(
        `INSERT INTO languages (id, site_id, code, name, native_name, is_default, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          langId,
          siteId,
          installLocale.code,
          installLocale.name,
          installLocale.nativeName,
          isDefault,
          isDefault,
          0,
          now(),
          now(),
        ],
      );
    } catch (e) {
      console.error("[justflows] install: language seed failed:", e);
      emit("error", "Could not set up the default language. Check the server log for details.");
      res.end();
      return;
    }

    emit("step", "Finalising installation…");
    const { randomBytes } = await import("node:crypto");
    await markInstalled({
      installedAt: new Date().toISOString(),
      siteId,
      dbDriver: db.driver,
      dbHost: db.host,
      dbPort: db.port,
      dbName: db.database,
      dbUser: db.username,
      dbPassword: db.password,
      databaseUrl: dbUrl,
      appUrl: site.url,
      appSecret: randomBytes(48).toString("hex"),
      version: getJustflowsVersion(),
    });

    resetDb();
    await sql.close();
    await (await import("../lib/plugin-runtime.js")).ensurePluginRuntime();
    await (await import("../lib/search-db.js")).startSearchIndex(siteId);

    if (account.emailDetails) {
      const mailed = await sendInstallDetailsMail({
        to: account.email,
        siteName: site.name,
        siteUrl: site.url,
        locale: installLocale.code,
        localeName: installLocale.name,
        username: account.username,
        email: account.email,
        password: account.password,
        dbDriver: db.driver,
        dbHost: db.host,
        dbPort: db.port,
        dbName: db.database,
        dbUser: db.username,
      });
      emit(
        "step",
        mailed.ok
          ? `Sent site details to ${account.email}`
          : "Could not email site details. The site is still installed — sign in with the account you just created.",
      );
    }

    emit("done", "Justflows installed successfully");
  } catch (err) {
    console.error("[justflows] install failed:", err);
    emit("error", "Installation failed. Check the server log for details.");
  } finally {
    res.end();
  }
});

export default router;
