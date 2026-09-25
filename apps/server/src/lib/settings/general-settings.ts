import { getDb } from "../database/db.js";
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_START_OF_WEEK,
  DEFAULT_TIME_FORMAT,
  DEFAULT_TIMEZONE,
  formatPhpDate,
  isValidTimeZone,
} from "../i18n/datetime-format.js";
import { listAssignableRoles } from "../auth/assignable-roles.js";
import { USER_ROLE_VALUES } from "../auth/rbac.js";
import { getSiteId, getSiteSetting } from "./site-settings.js";

export interface GeneralSettings {
  adminEmail: string;
  usersCanRegister: boolean;
  defaultRole: string;
  /** Whether the emailed self-service "forgot password" flow is offered. */
  passwordResetEnabled: boolean;
  /**
   * Roles the self-service reset is limited to. Empty means every role — the
   * default. A non-empty list restricts it (an administrator wanting staff to
   * recover by email while subscribers cannot, or the reverse).
   */
  passwordResetRoles: string[];
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  startOfWeek: number;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

async function fallbackAdminEmail(): Promise<string> {
  try {
    const db = await getDb();
    const rows = await db.query<{ email: string }>(
      "SELECT email FROM users WHERE role = ? ORDER BY created_at ASC LIMIT 1",
      ["administrator"],
    );
    return rows[0]?.email ?? "";
  } catch {
    return "";
  }
}

export async function getGeneralSettings(siteId?: string | null): Promise<GeneralSettings> {
  const id = siteId ?? (await getSiteId());
  if (!id) {
    return {
      adminEmail: "",
      usersCanRegister: false,
      defaultRole: "subscriber",
      passwordResetEnabled: true,
      passwordResetRoles: [],
      timezone: DEFAULT_TIMEZONE,
      dateFormat: DEFAULT_DATE_FORMAT,
      timeFormat: DEFAULT_TIME_FORMAT,
      startOfWeek: DEFAULT_START_OF_WEEK,
    };
  }

  const [
    storedEmail,
    usersCanRegister,
    defaultRoleRaw,
    passwordResetEnabledRaw,
    passwordResetRolesRaw,
    timezoneRaw,
    dateFormat,
    timeFormat,
    startOfWeekRaw,
  ] = await Promise.all([
    getSiteSetting<string>(id, "admin_email"),
    getSiteSetting<boolean>(id, "users_can_register"),
    getSiteSetting<string>(id, "default_role"),
    getSiteSetting<boolean>(id, "password_reset_enabled"),
    getSiteSetting<string[]>(id, "password_reset_roles"),
    getSiteSetting<string>(id, "timezone"),
    getSiteSetting<string>(id, "date_format"),
    getSiteSetting<string>(id, "time_format"),
    getSiteSetting<number>(id, "start_of_week"),
  ]);

  const timezone = asString(timezoneRaw, DEFAULT_TIMEZONE);
  const defaultRole = asString(defaultRoleRaw, "subscriber");
  const startOfWeek = asInt(startOfWeekRaw, DEFAULT_START_OF_WEEK);
  const assignable = new Set((await listAssignableRoles()).map((role) => role.id));
  const passwordResetRoles = Array.isArray(passwordResetRolesRaw)
    ? passwordResetRolesRaw.filter((role): role is string => assignable.has(String(role)))
    : [];
  const coversEveryCoreRole = USER_ROLE_VALUES.every((role) => passwordResetRoles.includes(role));

  return {
    adminEmail: asString(storedEmail, "") || (await fallbackAdminEmail()),
    usersCanRegister: asBool(usersCanRegister, false),
    defaultRole: assignable.has(defaultRole) ? defaultRole : "subscriber",
    // Absent setting means "on": recovery is a safety net you have to opt out of.
    passwordResetEnabled: asBool(passwordResetEnabledRaw, true),
    passwordResetRoles: coversEveryCoreRole ? [] : passwordResetRoles,
    timezone: isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE,
    dateFormat: asString(dateFormat, DEFAULT_DATE_FORMAT),
    timeFormat: asString(timeFormat, DEFAULT_TIME_FORMAT),
    startOfWeek: startOfWeek >= 0 && startOfWeek <= 6 ? startOfWeek : DEFAULT_START_OF_WEEK,
  };
}

export async function formatContentDate(date: Date | string): Promise<string> {
  const settings = await getGeneralSettings();
  const d = typeof date === "string" ? new Date(date) : date;
  return formatPhpDate(d, settings.dateFormat, { timeZone: settings.timezone });
}
