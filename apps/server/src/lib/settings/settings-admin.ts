// SPDX-License-Identifier: MIT

import { z } from "zod";
import { getDb } from "../database/db.js";
import { getSiteId, setSiteSetting, settingsKeyColumn } from "./site-settings.js";
import { revalidateOnUpdate } from "../cache/cache-revalidate.js";
import { formatPhpDate, isValidTimeZone, listTimeZones } from "../i18n/datetime-format.js";
import { getGeneralSettings } from "./general-settings.js";
import { getDefaultLocale, listLanguages, setDefaultLanguageByCode } from "../i18n/languages-db.js";
import { isAssignableRole, listAssignableRoles } from "../auth/assignable-roles.js";
import { STORED_ROLE_ID, USER_ROLE_VALUES } from "../auth/rbac.js";
import { getHomePageId } from "../content/home-page.js";
import { getBlogPageId } from "../content/blog-page.js";
import { getMailConfig, saveMailConfig, toPublicMailSettings, type MailTransport } from "../email/mail.js";
import { isMailTransport } from "../email/mail-config.js";
import { sanitizeFaviconUrl } from "../media/favicon.js";
import { SiteUrlSchema } from "./site-url.js";
import { updateEnvKeys } from "./env-file.js";
import { auditLog } from "../security/audit-log.js";
import { resolveFaviconUrl } from "../themes/theme-customize.js";

/**
 * Shared site-settings read/write behind both `routes/settings.ts` (cookie
 * auth) and the federated management API. Callers do the capability check
 * (`settings:read` / `settings:manage`) and supply the actor.
 */

export const SettingsSchema = z.object({
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
  default_role: z.string().regex(STORED_ROLE_ID).optional(),
  password_reset_enabled: z.boolean().optional(),
  password_reset_roles: z.array(z.string().regex(STORED_ROLE_ID)).max(32).optional(),
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
export type SettingsInput = z.infer<typeof SettingsSchema>;

/**
 * Settings any signed-in user may read. Everything omitted here — the mail
 * transport, the admin address, and the registration policy — is administrator
 * only: a self-registered subscriber should not learn the SMTP host and
 * username, which are enough to start guessing at the mail account.
 */
export const SESSION_READABLE_KEYS = new Set([
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

export interface SettingsActor {
  siteId: string;
  userId: string;
  role: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SettingsResult {
  status: number;
  body: unknown;
}

export async function getSettingsPayload(opts: { isAdmin: boolean }): Promise<Record<string, unknown>> {
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
    assignable_roles: (await listAssignableRoles()).map(({ id, label }) => ({ id, label })),
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

  if (opts.isAdmin) return payload;
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => SESSION_READABLE_KEYS.has(key)),
  );
}

export async function applySettingsChange(
  body: SettingsInput,
  actor: SettingsActor,
): Promise<SettingsResult> {
  if (body.default_role !== undefined && !(await isAssignableRole(body.default_role))) {
    return { status: 400, body: { error: "Unknown role" } };
  }
  if (
    body.password_reset_roles !== undefined &&
    (await Promise.all(body.password_reset_roles.map((role) => isAssignableRole(role)))).some(
      (ok) => !ok,
    )
  ) {
    return { status: 400, body: { error: "Unknown role" } };
  }

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
  }

  const siteId = await getSiteId();

  if (siteUpdates.length > 0) {
    if (!siteId) return { status: 503, body: { error: "No site found — complete install first" } };
    siteParams.push(siteId);
    await db.run(`UPDATE sites SET ${siteUpdates.join(", ")} WHERE id = ?`, siteParams);
  }

  if (body.site_url !== undefined) {
    // Persist to .env, not just process.env, so the value survives a restart
    // instead of reverting to whatever loadConfig() last read from disk.
    await updateEnvKeys({ APP_URL: body.site_url });
    process.env.APP_URL = body.site_url;
  }

  const settingsToUpdate: [string, unknown][] = [];
  if (body.posts_per_page !== undefined) settingsToUpdate.push(["posts_per_page", body.posts_per_page]);
  if (body.trash_retention_days !== undefined)
    settingsToUpdate.push(["trash_retention_days", body.trash_retention_days]);
  if (body.timezone !== undefined) settingsToUpdate.push(["timezone", body.timezone]);
  if (body.site_public !== undefined) settingsToUpdate.push(["site_public", body.site_public]);
  if (body.public_api_enabled !== undefined)
    settingsToUpdate.push(["public_api_enabled", body.public_api_enabled]);
  if (body.discourage_search_engines !== undefined)
    settingsToUpdate.push(["discourage_search_engines", body.discourage_search_engines]);
  if (body.admin_email !== undefined) settingsToUpdate.push(["admin_email", body.admin_email]);
  if (body.users_can_register !== undefined)
    settingsToUpdate.push(["users_can_register", body.users_can_register]);
  if (body.default_role !== undefined) settingsToUpdate.push(["default_role", body.default_role]);
  if (body.password_reset_enabled !== undefined)
    settingsToUpdate.push(["password_reset_enabled", body.password_reset_enabled]);
  if (body.password_reset_roles !== undefined) {
    const roles = [...new Set(body.password_reset_roles)];
    settingsToUpdate.push([
      "password_reset_roles",
      roles.length === USER_ROLE_VALUES.length ? [] : roles,
    ]);
  }
  if (body.date_format !== undefined) settingsToUpdate.push(["date_format", body.date_format]);
  if (body.time_format !== undefined) settingsToUpdate.push(["time_format", body.time_format]);
  if (body.start_of_week !== undefined) settingsToUpdate.push(["start_of_week", body.start_of_week]);
  if (body.favicon_url !== undefined)
    settingsToUpdate.push(["favicon_url", sanitizeFaviconUrl(body.favicon_url)]);

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

  if (!siteId && settingsToUpdate.length > 0) {
    return { status: 503, body: { error: "No site found — complete install first" } };
  }
  for (const [key, value] of settingsToUpdate) {
    await setSiteSetting(siteId!, key, value);
  }

  // Keys, never values: a settings write can carry an SMTP password.
  const changedKeys = settingsToUpdate.map(([k]) => k);
  if (changedKeys.length > 0 || siteUpdates.length > 0) {
    void auditLog({
      siteId: actor.siteId,
      action: "settings.changed",
      actorId: actor.userId,
      actorRole: actor.role,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      detail: [...changedKeys, ...(siteUpdates.length ? ["site"] : [])].join(", "),
    });
  }
  if (body.public_api_enabled !== undefined) {
    void auditLog({
      siteId: actor.siteId,
      action: "public_api.toggled",
      actorId: actor.userId,
      actorRole: actor.role,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      detail: body.public_api_enabled ? "enabled" : "disabled",
    });
  }

  if (mailTouched && siteId) await saveMailConfig(siteId, mailPatch);
  if (body.site_language !== undefined && siteId) {
    await setDefaultLanguageByCode(siteId, body.site_language);
  }

  await revalidateOnUpdate("settings");

  if (siteId && (body.site_name !== undefined || body.site_description !== undefined)) {
    const { getActiveTheme } = await import("../themes/themes-db.js");
    const { getThemeMods, saveThemeMods } = await import("../themes/theme-customize.js");
    const theme = await getActiveTheme(siteId);
    if (theme) {
      const published = (await getThemeMods(theme.theme_id, false)) ?? {};
      await saveThemeMods(theme.theme_id, published, false);
    }
  }

  return { status: 200, body: { ok: true } };
}
