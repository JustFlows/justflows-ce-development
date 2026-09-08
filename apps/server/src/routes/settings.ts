import { Router } from "express";
import { z } from "zod";
import { getDb } from "../lib/db.js";
import { getSiteId, setSiteSetting, settingsKeyColumn } from "../lib/site-settings.js";
import { revalidateOnUpdate } from "../lib/cache-revalidate.js";
import { requireCapability, requireRole, requireSession } from "../middleware/auth.js";
import { formatPhpDate, isValidTimeZone, listTimeZones } from "../lib/datetime-format.js";
import { getGeneralSettings } from "../lib/general-settings.js";
import {
  getDefaultLocale,
  listLanguages,
  setDefaultLanguageByCode,
} from "../lib/i18n/languages-db.js";
import { THEME_CUSTOMIZE_ROLES, USER_ROLE_VALUES } from "../lib/rbac.js";
import { getHomePageId, setHomePageId } from "../lib/home-page.js";
import { getBlogPageId, setBlogPageId } from "../lib/blog-page.js";
import {
  getMailConfig,
  saveMailConfig,
  sendTestMail,
  toPublicMailSettings,
  listEmailDeliveries,
  retryEmailDelivery,
  addEmailSuppression,
  listEmailSuppressions,
  removeEmailSuppression,
  type MailTransport,
} from "../lib/mail.js";
import { isMailTransport } from "../lib/mail-config.js";
import { sanitizeFaviconUrl } from "../lib/favicon.js";
import { SiteUrlSchema } from "../lib/site-url.js";
import { auditFromRequest } from "../lib/audit-log.js";
import { resolveFaviconUrl } from "../lib/theme-customize.js";
import { sendServerError } from "../lib/send-error.js";
import type { CommentSettings } from "../lib/comments-settings.js";

import { PermalinkSettingsSchema, PERMALINK_PRESETS } from "../lib/permalinks.js";
import { getPermalinkState, savePermalinks, PermalinkConflictError } from "../lib/permalinks-db.js";
import { listContentTypes } from "../lib/content-types-db.js";

const router = Router();
router.get("/permalinks", requireSession, requireRole("administrator"), async (req, res) => {
  try {
    const siteId = req.session!.siteId;
    const state = await getPermalinkState(siteId);
    const db = await getDb();
    const taxonomies = await db.query<{ slug: string; name: string }>("SELECT slug, name FROM taxonomies WHERE site_id = ? ORDER BY slug", [siteId]);
    res.json({ ...state, presets: PERMALINK_PRESETS, types: await listContentTypes(siteId), taxonomies });
  } catch (err) { sendServerError(res, "permalinks", err); }
});
router.put("/permalinks", requireSession, requireRole("administrator"), async (req, res) => {
  const parsed = PermalinkSettingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message }); return; }
  try {
    const redirectsCreated = await savePermalinks(req.session!.siteId, parsed.data);
    auditFromRequest(req, "settings.changed", { detail: "permalinks" });
    res.json({ ok: true, redirectsCreated });
  } catch (err) {
    if (err instanceof PermalinkConflictError) { res.status(409).json({ error: err.message }); return; }
    sendServerError(res, "permalinks", err);
  }
});

const Schema = z.object({
  site_name: z.string().min(1).optional(),
  site_description: z.string().optional(),
  site_url: SiteUrlSchema.optional(),
  posts_per_page: z.coerce.number().int().min(1).max(100).optional(),
  trash_retention_days: z.coerce.number().int().min(1).max(3650).optional(),
  timezone: z
    .string()
    .refine((tz) => isValidTimeZone(tz), "Invalid timezone")
    .optional(),
  site_public: z.boolean().optional(),
  public_api_enabled: z.boolean().optional(),
  discourage_search_engines: z.boolean().optional(),
  admin_email: z.string().email().optional(),
  users_can_register: z.boolean().optional(),
  default_role: z.enum(USER_ROLE_VALUES).optional(),
  password_reset_enabled: z.boolean().optional(),
  // Empty array = every role may self-serve (the default).
  password_reset_roles: z.array(z.enum(USER_ROLE_VALUES)).max(USER_ROLE_VALUES.length).optional(),
  site_language: z.string().min(2).max(20).optional(),
  date_format: z.string().min(1).max(50).optional(),
  time_format: z.string().min(1).max(50).optional(),
  start_of_week: z.coerce.number().int().min(0).max(6).optional(),
  mail_transport: z
    .string()
    .refine((value) => isMailTransport(value), "Invalid mail transport")
    .optional(),
  mail_from_name: z.string().max(120).optional(),
  mail_from_address: z.string().email().or(z.literal("")).optional(),
  mail_reply_to: z.string().email().or(z.literal("")).optional(),
  mail_envelope_sender: z.string().email().or(z.literal("")).optional(),
  smtp_host: z.string().max(255).optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  smtp_secure: z.enum(["none", "starttls", "ssl"]).optional(),
  smtp_user: z.string().max(320).optional(),
  smtp_pass: z.string().max(500).optional(),
  mail_rate_limit: z.coerce.number().int().min(1).max(10000).optional(),
  mail_concurrency: z.coerce.number().int().min(1).max(100).optional(),
  favicon_url: z.string().max(2048).optional(),
});

/**
 * Settings any signed-in user may read. Everything omitted here — the mail
 * transport, the admin address, and the registration policy — is administrator
 * only: a self-registered subscriber should not learn the SMTP host and
 * username, which are enough to start guessing at the mail account.
 */
const SESSION_READABLE_KEYS = new Set([
  "site_name",
  "site_description",
  "site_url",
  "posts_per_page",
  "trash_retention_days",
  "timezone",
  "timezones",
  "utc_time",
  "local_time",
  "active_theme",
  "site_public",
  "site_language",
  "languages",
  "date_format",
  "time_format",
  "start_of_week",
  "favicon_url",
  "home_page_id",
  "blog_page_id",
]);

router.get("/", requireSession, async (req, res) => {
  const isAdmin = req.session?.role === "administrator";
  try {
    const db = await getDb();
    const settingsSiteId = await getSiteId();
    const siteRows = settingsSiteId
      ? await db.query<{ name: string; url: string; description: string | null }>(
          "SELECT name, url, description FROM sites WHERE id = ? LIMIT 1",
          [settingsSiteId],
        )
      : await db.query<{ name: string; url: string; description: string | null }>(
          "SELECT name, url, description FROM sites LIMIT 1",
        );
    const site = siteRows[0] ?? { name: "", url: "", description: "" };

    // Scoped, and no longer capped. The old LIMIT 100 had no ORDER BY either,
    // so once plugin settings pushed the table past a hundred rows the database
    // could drop `active_theme` from the result and the site would quietly fall
    // back to the default theme. Only the handful of keys read below are
    // returned to the caller, so the row count is not the thing to bound here.
    const settingRows = settingsSiteId
      ? await db.query<{ k: string; value: string }>(
          `SELECT ${settingsKeyColumn()} AS k, value FROM site_settings WHERE site_id = ?`,
          [settingsSiteId],
        )
      : await db.query<{ k: string; value: string }>(
          `SELECT ${settingsKeyColumn()} AS k, value FROM site_settings`,
        );
    const extras: Record<string, unknown> = {};
    for (const row of settingRows) {
      try {
        extras[row.k] = JSON.parse(row.value);
      } catch {
        extras[row.k] = row.value;
      }
    }

    const general = await getGeneralSettings();
    const mail = toPublicMailSettings(await getMailConfig());
    const languages = await listLanguages();
    const siteLanguage = await getDefaultLocale();
    const siteId = await getSiteId();
    const now = new Date();
    const timezone = general.timezone;

    const payload: Record<string, unknown> = {
      site_name: site.name,
      site_description: site.description ?? "",
      site_url: site.url,
      posts_per_page: extras["posts_per_page"] ?? 10,
      trash_retention_days: extras["trash_retention_days"] ?? 30,
      timezone,
      timezones: listTimeZones(),
      utc_time: formatPhpDate(now, "Y-m-d H:i:s", { timeZone: "UTC" }),
      local_time: formatPhpDate(now, "Y-m-d H:i:s", { timeZone: timezone }),
      active_theme: extras["active_theme"] ?? "justflows.default",
      site_public: extras["site_public"] === true,
      public_api_enabled:
        "public_api_enabled" in extras ? extras["public_api_enabled"] === true : false,
      discourage_search_engines:
        "discourage_search_engines" in extras ? extras["discourage_search_engines"] === true : true,
      admin_email: general.adminEmail,
      users_can_register: general.usersCanRegister,
      default_role: general.defaultRole,
      password_reset_enabled: general.passwordResetEnabled,
      password_reset_roles: general.passwordResetRoles,
      site_language: siteLanguage,
      languages: languages.map((l) => ({
        code: l.code,
        name: l.name,
        nativeName: l.nativeName,
        isDefault: l.isDefault,
        isActive: l.isActive,
      })),
      date_format: general.dateFormat,
      time_format: general.timeFormat,
      start_of_week: general.startOfWeek,
      mail_transport: mail.transport,
      mail_from_name: mail.fromName,
      mail_from_address: mail.fromAddress,
      mail_reply_to: mail.replyTo,
      mail_envelope_sender: mail.envelopeSender,
      smtp_host: mail.smtpHost,
      smtp_port: mail.smtpPort,
      smtp_secure: mail.smtpSecure,
      smtp_user: mail.smtpUser,
      smtp_pass_set: mail.smtpPassSet,
      mail_rate_limit: mail.rateLimitPerMinute,
      mail_concurrency: mail.concurrency,
      mail_transports: mail.transports,
      favicon_url: await resolveFaviconUrl(),
      home_page_id: siteId ? await getHomePageId(siteId) : null,
      blog_page_id: siteId ? await getBlogPageId(siteId) : null,
    };

    if (isAdmin) {
      res.json(payload);
      return;
    }

    res.json(
      Object.fromEntries(Object.entries(payload).filter(([key]) => SESSION_READABLE_KEYS.has(key))),
    );
  } catch (e) {
    sendServerError(res, "settings", e);
  }
});

router.post("/", requireRole("administrator"), async (req, res) => {
  try {
    const body = Schema.parse(req.body);
    const db = await getDb();

    const siteUpdates: string[] = [];
    const siteParams: (string | number | boolean | null)[] = [];

    if (body.site_name !== undefined) {
      siteUpdates.push("name = ?");
      siteParams.push(body.site_name);
    }
    if (body.site_description !== undefined) {
      siteUpdates.push("description = ?");
      siteParams.push(body.site_description);
    }
    if (body.site_url !== undefined) {
      siteUpdates.push("url = ?");
      siteParams.push(body.site_url);
      process.env.APP_URL = body.site_url;
    }

    const siteId = await getSiteId();

    if (siteUpdates.length > 0) {
      if (!siteId) {
        res.status(503).json({ error: "No site found — complete install first" });
        return;
      }
      // Addressed by id. `UPDATE ... ORDER BY ... LIMIT` is a MySQL extension
      // and a syntax error on PostgreSQL, so this statement could never have
      // run on a postgres install.
      siteParams.push(siteId);
      await db.run(`UPDATE sites SET ${siteUpdates.join(", ")} WHERE id = ?`, siteParams);
    }
    const settingsToUpdate: [string, unknown][] = [];
    if (body.posts_per_page !== undefined)
      settingsToUpdate.push(["posts_per_page", body.posts_per_page]);
    if (body.trash_retention_days !== undefined)
      settingsToUpdate.push(["trash_retention_days", body.trash_retention_days]);
    if (body.timezone !== undefined) settingsToUpdate.push(["timezone", body.timezone]);
    if (body.site_public !== undefined) settingsToUpdate.push(["site_public", body.site_public]);
    if (body.public_api_enabled !== undefined) {
      settingsToUpdate.push(["public_api_enabled", body.public_api_enabled]);
    }
    if (body.discourage_search_engines !== undefined) {
      settingsToUpdate.push(["discourage_search_engines", body.discourage_search_engines]);
    }
    if (body.admin_email !== undefined) settingsToUpdate.push(["admin_email", body.admin_email]);
    if (body.users_can_register !== undefined) {
      settingsToUpdate.push(["users_can_register", body.users_can_register]);
    }
    if (body.default_role !== undefined) settingsToUpdate.push(["default_role", body.default_role]);
    if (body.password_reset_enabled !== undefined) {
      settingsToUpdate.push(["password_reset_enabled", body.password_reset_enabled]);
    }
    if (body.password_reset_roles !== undefined) {
      // Store the distinct set; "all roles" collapses to an empty list.
      const roles = [...new Set(body.password_reset_roles)];
      settingsToUpdate.push([
        "password_reset_roles",
        roles.length === USER_ROLE_VALUES.length ? [] : roles,
      ]);
    }
    if (body.date_format !== undefined) settingsToUpdate.push(["date_format", body.date_format]);
    if (body.time_format !== undefined) settingsToUpdate.push(["time_format", body.time_format]);
    if (body.start_of_week !== undefined)
      settingsToUpdate.push(["start_of_week", body.start_of_week]);
    if (body.favicon_url !== undefined) {
      settingsToUpdate.push(["favicon_url", sanitizeFaviconUrl(body.favicon_url)]);
    }

    const mailPatch = {
      ...(body.mail_transport !== undefined
        ? { transport: body.mail_transport as MailTransport }
        : {}),
      ...(body.mail_from_name !== undefined ? { fromName: body.mail_from_name } : {}),
      ...(body.mail_from_address !== undefined ? { fromAddress: body.mail_from_address } : {}),
      ...(body.mail_reply_to !== undefined ? { replyTo: body.mail_reply_to } : {}),
      ...(body.mail_envelope_sender !== undefined
        ? { envelopeSender: body.mail_envelope_sender }
        : {}),
      ...(body.smtp_host !== undefined ? { smtpHost: body.smtp_host } : {}),
      ...(body.smtp_port !== undefined ? { smtpPort: body.smtp_port } : {}),
      ...(body.smtp_secure !== undefined ? { smtpSecure: body.smtp_secure } : {}),
      ...(body.smtp_user !== undefined ? { smtpUser: body.smtp_user } : {}),
      ...(body.smtp_pass !== undefined ? { smtpPass: body.smtp_pass } : {}),
      ...(body.mail_rate_limit !== undefined ? { rateLimitPerMinute: body.mail_rate_limit } : {}),
      ...(body.mail_concurrency !== undefined ? { concurrency: body.mail_concurrency } : {}),
    };
    const mailTouched = Object.keys(mailPatch).length > 0;

    // setSiteSetting already branches on the driver. The old else-branch here
    // was raw MySQL — UUID(), NOW() and ON DUPLICATE KEY — and would have
    // thrown on PostgreSQL for a site that has no id, which is a state this
    // handler now rejects outright above.
    if (!siteId && settingsToUpdate.length > 0) {
      res.status(503).json({ error: "No site found — complete install first" });
      return;
    }
    for (const [key, value] of settingsToUpdate) {
      await setSiteSetting(siteId!, key, value);
    }

    // Keys, never values: a settings write can carry an SMTP password.
    const changedKeys = settingsToUpdate.map(([k]) => k);
    if (changedKeys.length > 0 || siteUpdates.length > 0) {
      auditFromRequest(req, "settings.changed", {
        detail: [...changedKeys, ...(siteUpdates.length ? ["site"] : [])].join(", "),
      });
    }
    // Called out separately because it moves the whole public API surface
    // between reachable and 404.
    if (body.public_api_enabled !== undefined) {
      auditFromRequest(req, "public_api.toggled", {
        detail: body.public_api_enabled ? "enabled" : "disabled",
      });
    }

    if (mailTouched && siteId) {
      await saveMailConfig(siteId, mailPatch);
    }

    if (body.site_language !== undefined && siteId) {
      await setDefaultLanguageByCode(siteId, body.site_language);
    }

    await revalidateOnUpdate("settings");

    if (siteId && (body.site_name !== undefined || body.site_description !== undefined)) {
      const { getActiveTheme } = await import("../lib/themes-db.js");
      const { getThemeMods, saveThemeMods } = await import("../lib/theme-customize.js");
      const theme = await getActiveTheme(siteId);
      if (theme) {
        const published = (await getThemeMods(theme.theme_id, false)) ?? {};
        await saveThemeMods(theme.theme_id, published, false);
      }
    }

    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: e.issues[0]?.message ?? "Invalid settings" });
      return;
    }
    sendServerError(res, "settings", e);
  }
});

const HomePageSchema = z.object({
  contentId: z.string().uuid().nullable(),
});

router.put("/home-page", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const body = HomePageSchema.parse(req.body);
    const homePageId = await setHomePageId(siteId, body.contentId);
    res.json({ ok: true, homePageId });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: e.issues[0]?.message ?? "Invalid home page" });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const status = message === "Page not found" || message === "Home must be a page" ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

const BlogPageSchema = z.object({
  contentId: z.string().uuid().nullable(),
});

router.put("/blog-page", requireRole(...THEME_CUSTOMIZE_ROLES), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const body = BlogPageSchema.parse(req.body);
    const blogPageId = await setBlogPageId(siteId, body.contentId);
    res.json({ ok: true, blogPageId });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: e.issues[0]?.message ?? "Invalid blog page" });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const status =
      message === "Page not found" || message === "Blog page must be a page" ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

const CommentSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  requireModeration: z.boolean().optional(),
  closeAfterDays: z.coerce.number().int().min(0).max(3650).optional(),
  allowUrls: z.boolean().optional(),
  notifyModerator: z.boolean().optional(),
  maxLength: z.coerce.number().int().min(200).max(20_000).optional(),
  threadMaxDepth: z.coerce.number().int().min(1).max(10).optional(),
  pageSize: z.coerce.number().int().min(5).max(200).optional(),
  captchaProvider: z
    .enum(["none", "turnstile", "hcaptcha", "recaptcha", "recaptcha-v3"])
    .optional(),
  captchaSiteKey: z.string().max(200).optional(),
  captchaScoreThreshold: z.coerce.number().min(0).max(1).optional(),
  // Write-only. An empty string leaves the stored secret untouched.
  captchaSecretKey: z.string().max(200).optional(),
});

router.get("/comments", requireRole("administrator"), async (_req, res) => {
  try {
    const { getCommentSettings, toPublicCommentSettings } =
      await import("../lib/comments-settings.js");
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    res.json(toPublicCommentSettings(await getCommentSettings(siteId)));
  } catch (e) {
    sendServerError(res, "settings", e);
  }
});

router.put("/comments", requireRole("administrator"), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) {
      res.status(503).json({ error: "No site found" });
      return;
    }
    const body = CommentSettingsSchema.parse(req.body);
    const { saveCommentSettings, toPublicCommentSettings } =
      await import("../lib/comments-settings.js");
    const patch: Partial<CommentSettings> = { ...body };
    // An omitted or blank secret means "keep the current one".
    if (!body.captchaSecretKey) delete patch.captchaSecretKey;
    const saved = await saveCommentSettings(siteId, patch);
    auditFromRequest(req, "settings.changed", { detail: "comments" });
    await revalidateOnUpdate("settings");
    const { invalidatePublicPages } = await import("../lib/public-cache.js");
    await invalidatePublicPages();
    res.json(toPublicCommentSettings(saved));
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: e.issues[0]?.message ?? "Invalid comment settings" });
      return;
    }
    sendServerError(res, "settings", e);
  }
});

router.post("/test-mail", requireCapability("mail:manage"), async (_req, res) => {
  try {
    const result = await sendTestMail();
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (e) {
    sendServerError(res, "settings", e);
  }
});

router.get("/email/logs", requireCapability("mail:read"), async (req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) return void res.status(503).json({ error: "No site found" });
    const status = z
      .enum(["queued", "sent", "deferred", "failed", "bounced"])
      .optional()
      .parse(
        typeof req.query.status === "string" && req.query.status ? req.query.status : undefined,
      );
    res.json({ deliveries: await listEmailDeliveries(siteId, status) });
  } catch (e) {
    if (e instanceof z.ZodError)
      return void res.status(400).json({ error: "Invalid email status" });
    sendServerError(res, "email logs", e);
  }
});

router.post("/email/logs/:id/retry", requireCapability("mail:manage"), async (req, res) => {
  try {
    const parsed = z.string().uuid().safeParse(req.params.id);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid delivery id" });
    const siteId = await getSiteId();
    if (!siteId) return void res.status(503).json({ error: "No site found" });
    const result = await retryEmailDelivery(siteId, parsed.data);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    sendServerError(res, "email retry", e);
  }
});

const SuppressionSchema = z.object({
  email: z.string().email(),
  messageType: z.string().min(1).max(80).default("*"),
  reason: z.string().max(500).optional(),
});
router.get("/email/suppressions", requireCapability("mail:read"), async (_req, res) => {
  try {
    const siteId = await getSiteId();
    if (!siteId) return void res.status(503).json({ error: "No site found" });
    res.json({ suppressions: await listEmailSuppressions(siteId) });
  } catch (e) {
    sendServerError(res, "email suppressions", e);
  }
});
router.post("/email/suppressions", requireCapability("mail:manage"), async (req, res) => {
  try {
    const body = SuppressionSchema.parse(req.body);
    const siteId = await getSiteId();
    if (!siteId) return void res.status(503).json({ error: "No site found" });
    await addEmailSuppression(siteId, body.email, body.messageType, body.reason);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError)
      return void res.status(400).json({ error: e.issues[0]?.message ?? "Invalid suppression" });
    sendServerError(res, "email suppression", e);
  }
});
router.delete("/email/suppressions/:id", requireCapability("mail:manage"), async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const siteId = await getSiteId();
    if (!siteId) return void res.status(503).json({ error: "No site found" });
    await removeEmailSuppression(siteId, id);
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError)
      return void res.status(400).json({ error: "Invalid suppression id" });
    sendServerError(res, "email suppression", e);
  }
});

export default router;
