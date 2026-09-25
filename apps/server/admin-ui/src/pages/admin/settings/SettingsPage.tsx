import { publicAdminPath } from "../../../admin-path";
import { useEffect, useMemo, useState } from "react";
import {
  DATE_FORMAT_PRESETS,
  TIME_FORMAT_PRESETS,
  WEEKDAYS,
  formatPhpDate,
} from "@lib/i18n/datetime-format";
import MediaImageField from "@components/MediaImageField";
import { useCapability, useSessionRole } from "@components/SessionProvider";
import { initialJson } from "../../../ssr-data";
import { useT } from "../../../i18n/I18nProvider";

const ROLE_OPTIONS = ["subscriber", "contributor", "author", "editor", "administrator"] as const;

type AssignableRoleOption = { id: string; label: string };

const CORE_ROLE_OPTIONS: AssignableRoleOption[] = ROLE_OPTIONS.map((id) => ({ id, label: id }));

function rolesFromPayload(data: SettingsPayload | null | undefined): AssignableRoleOption[] {
  const raw = data?.assignable_roles;
  if (!Array.isArray(raw)) return CORE_ROLE_OPTIONS;
  const parsed = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as { id?: unknown; label?: unknown };
    const id = typeof record.id === "string" ? record.id : "";
    const label = typeof record.label === "string" && record.label ? record.label : id;
    return id ? [{ id, label }] : [];
  });
  return parsed.length > 0 ? parsed : CORE_ROLE_OPTIONS;
}

function roleOptionLabel(role: AssignableRoleOption, translate: (key: string) => string): string {
  const key = `settings.membership.roles.${role.id}`;
  const translated = translate(key);
  return translated === key ? role.label : translated;
}

interface MaintenanceState {
  enabled: boolean;
  heading: string;
  message: string;
}

const EMPTY_MAINTENANCE: MaintenanceState = { enabled: false, heading: "", message: "" };

interface ErrorCopyState {
  heading: string;
  message: string;
}

const EMPTY_ERROR_500: ErrorCopyState = { heading: "", message: "" };

type LanguageOption = {
  code: string;
  name: string;
  nativeName: string;
  isDefault: boolean;
  isActive: boolean;
};

type GeneralState = {
  name: string;
  description: string;
  url: string;
  adminEmail: string;
  usersCanRegister: boolean;
  defaultRole: string;
  siteLanguage: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  startOfWeek: number;
  postsPerPage: string;
  trashRetentionDays: string;
  sitePublic: boolean;
  discourageSearchEngines: boolean;
  mailTransport: string;
  mailFromName: string;
  mailFromAddress: string;
  mailReplyTo: string;
  mailEnvelopeSender: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: "none" | "starttls" | "ssl";
  smtpUser: string;
  smtpPass: string;
  smtpPassSet: boolean;
  mailRateLimit: string;
  mailConcurrency: string;
  faviconUrl: string;
};

const EMPTY: GeneralState = {
  name: "",
  description: "",
  url: "",
  adminEmail: "",
  usersCanRegister: false,
  defaultRole: "subscriber",
  siteLanguage: "en-US",
  timezone: "UTC",
  dateFormat: "F j, Y",
  timeFormat: "g:i a",
  startOfWeek: 1,
  postsPerPage: "10",
  trashRetentionDays: "30",
  sitePublic: false,
  discourageSearchEngines: true,
  mailTransport: "sendmail",
  mailFromName: "",
  mailFromAddress: "",
  mailReplyTo: "",
  mailEnvelopeSender: "",
  smtpHost: "localhost",
  smtpPort: "25",
  smtpSecure: "none",
  smtpUser: "",
  smtpPass: "",
  smtpPassSet: false,
  mailRateLimit: "60",
  mailConcurrency: "5",
  faviconUrl: "",
};

type SettingsPayload = Record<string, unknown> & {
  languages?: LanguageOption[];
  timezones?: string[];
  date_format?: string;
  time_format?: string;
  mail_transports?: Array<{ id: string; label: string }>;
  assignable_roles?: Array<{ id?: unknown; label?: unknown }>;
};

function generalFromPayload(data: SettingsPayload, fallbackName: string): GeneralState {
  return {
    name: typeof data.site_name === "string" ? data.site_name : fallbackName,
    description: typeof data.site_description === "string" ? data.site_description : "",
    url: typeof data.site_url === "string" ? data.site_url : "",
    adminEmail: typeof data.admin_email === "string" ? data.admin_email : "",
    usersCanRegister: data.users_can_register === true,
    defaultRole: typeof data.default_role === "string" ? data.default_role : "subscriber",
    siteLanguage: typeof data.site_language === "string" ? data.site_language : "en-US",
    timezone: typeof data.timezone === "string" ? data.timezone : "UTC",
    dateFormat: data.date_format ?? "F j, Y",
    timeFormat: data.time_format ?? "g:i a",
    startOfWeek: Number(data.start_of_week ?? 1),
    postsPerPage: String(data.posts_per_page ?? 10),
    trashRetentionDays: String(data.trash_retention_days ?? 30),
    sitePublic: data.site_public === true,
    discourageSearchEngines: data.discourage_search_engines === true,
    mailTransport: typeof data.mail_transport === "string" ? data.mail_transport : "sendmail",
    mailFromName: typeof data.mail_from_name === "string" ? data.mail_from_name : "",
    mailFromAddress: typeof data.mail_from_address === "string" ? data.mail_from_address : "",
    mailReplyTo: typeof data.mail_reply_to === "string" ? data.mail_reply_to : "",
    mailEnvelopeSender:
      typeof data.mail_envelope_sender === "string" ? data.mail_envelope_sender : "",
    smtpHost: typeof data.smtp_host === "string" ? data.smtp_host : "localhost",
    smtpPort: String(data.smtp_port ?? 25),
    smtpSecure:
      data.smtp_secure === "starttls" || data.smtp_secure === "ssl" ? data.smtp_secure : "none",
    smtpUser: typeof data.smtp_user === "string" ? data.smtp_user : "",
    smtpPass: "",
    smtpPassSet: data.smtp_pass_set === true,
    mailRateLimit: String(data.mail_rate_limit ?? 60),
    mailConcurrency: String(data.mail_concurrency ?? 5),
    faviconUrl: typeof data.favicon_url === "string" ? data.favicon_url : "",
  };
}

function groupTimezones(zones: string[]): Array<{ region: string; zones: string[] }> {
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "UTC";
    const list = groups.get(region) ?? [];
    list.push(zone);
    groups.set(region, list);
  }
  return Array.from(groups.entries()).map(([region, list]) => ({ region, zones: list }));
}

export default function SettingsPage() {
  // Reading settings is open to every admin-eligible role; saving them (and
  // sending a test email) is administrator-only.
  const { t } = useT();
  const canManage = useSessionRole() === "administrator";
  const canReadMail = useCapability("mail:read");
  const canManageMail = useCapability("mail:manage");
  const prefetched = initialJson<SettingsPayload>("/api/settings");
  const initialGeneral = prefetched ? generalFromPayload(prefetched, t("common.mySite")) : EMPTY;
  const [general, setGeneral] = useState<GeneralState>(initialGeneral);
  const [roleOptions, setRoleOptions] = useState<AssignableRoleOption[]>(() =>
    rolesFromPayload(prefetched),
  );
  const [languages, setLanguages] = useState<LanguageOption[]>(prefetched?.languages ?? []);
  const [timezones, setTimezones] = useState<string[]>(
    prefetched?.timezones?.length ? prefetched.timezones : ["UTC"],
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!prefetched);
  const [customDate, setCustomDate] = useState(
    prefetched
      ? !(DATE_FORMAT_PRESETS as readonly string[]).includes(initialGeneral.dateFormat)
      : false,
  );
  const [customTime, setCustomTime] = useState(
    prefetched
      ? !(TIME_FORMAT_PRESETS as readonly string[]).includes(initialGeneral.timeFormat)
      : false,
  );
  const [testingMail, setTestingMail] = useState(false);
  const [mailTest, setMailTest] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceState>(EMPTY_MAINTENANCE);
  const [maintenanceSaving, setMaintenanceSaving] = useState(false);
  const [maintenanceSaved, setMaintenanceSaved] = useState(false);
  const [errorPage500, setErrorPage500] = useState<ErrorCopyState>(EMPTY_ERROR_500);
  const [errorPage500Saving, setErrorPage500Saving] = useState(false);
  const [errorPage500Saved, setErrorPage500Saved] = useState(false);
  const [mailTransports, setMailTransports] = useState(
    prefetched?.mail_transports ?? [
      { id: "sendmail", label: t("settings.mail.transportSendmail") },
      { id: "smtp", label: t("settings.mail.transportSmtp") },
    ],
  );

  const now = useMemo(() => new Date(), [general.timezone, general.dateFormat, general.timeFormat]);
  const utcTime = formatPhpDate(now, "Y-m-d H:i:s", { timeZone: "UTC" });
  const localTime = formatPhpDate(now, "Y-m-d H:i:s", { timeZone: general.timezone || "UTC" });

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: SettingsPayload) => {
        const dateFormat = data.date_format ?? "F j, Y";
        const timeFormat = data.time_format ?? "g:i a";
        setGeneral(generalFromPayload(data, t("common.mySite")));
        setRoleOptions(rolesFromPayload(data));
        setLanguages(data.languages ?? []);
        setTimezones(
          Array.isArray(data.timezones) && data.timezones.length > 0 ? data.timezones : ["UTC"],
        );
        if (data.mail_transports) setMailTransports(data.mail_transports);
        setCustomDate(!(DATE_FORMAT_PRESETS as readonly string[]).includes(dateFormat));
        setCustomTime(!(TIME_FORMAT_PRESETS as readonly string[]).includes(timeFormat));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/error-pages")
      .then((r) => r.json())
      .then(
        (data: {
          config?: { maintenance?: Partial<MaintenanceState>; "500"?: Partial<ErrorCopyState> };
        }) => {
          const m = data.config?.maintenance;
          setMaintenance({
            enabled: m?.enabled ?? false,
            heading: m?.heading ?? "",
            message: m?.message ?? "",
          });
          const e500 = data.config?.["500"];
          setErrorPage500({ heading: e500?.heading ?? "", message: e500?.message ?? "" });
        },
      )
      .catch(() => {});
  }, []);

  async function saveMaintenance(next: MaintenanceState) {
    setMaintenance(next);
    setMaintenanceSaving(true);
    try {
      const res = await fetch("/api/error-pages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maintenance: next }),
      });
      if (res.ok) {
        setMaintenanceSaved(true);
        setTimeout(() => setMaintenanceSaved(false), 2000);
      }
    } catch {
      /* leave as-is; the toggle stays visually applied but unsaved */
    } finally {
      setMaintenanceSaving(false);
    }
  }

  async function saveErrorPage500(next: ErrorCopyState) {
    setErrorPage500(next);
    setErrorPage500Saving(true);
    try {
      const res = await fetch("/api/error-pages", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "500": next }),
      });
      if (res.ok) {
        setErrorPage500Saved(true);
        setTimeout(() => setErrorPage500Saved(false), 2000);
      }
    } catch {
      /* leave as-is; the fields stay visually applied but unsaved */
    } finally {
      setErrorPage500Saving(false);
    }
  }

  function patch(partial: Partial<GeneralState>) {
    setGeneral((s) => ({ ...s, ...partial }));
  }

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_name: general.name,
          site_description: general.description,
          site_url: general.url,
          admin_email: general.adminEmail,
          users_can_register: general.usersCanRegister,
          default_role: general.defaultRole,
          site_language: general.siteLanguage,
          timezone: general.timezone,
          date_format: general.dateFormat,
          time_format: general.timeFormat,
          start_of_week: general.startOfWeek,
          posts_per_page: Number(general.postsPerPage),
          trash_retention_days: Number(general.trashRetentionDays),
          site_public: general.sitePublic,
          discourage_search_engines: general.discourageSearchEngines,
          mail_transport: general.mailTransport,
          mail_from_name: general.mailFromName,
          mail_from_address: general.mailFromAddress,
          mail_reply_to: general.mailReplyTo,
          mail_envelope_sender: general.mailEnvelopeSender,
          smtp_host: general.smtpHost,
          smtp_port: Number(general.smtpPort),
          smtp_secure: general.smtpSecure,
          smtp_user: general.smtpUser,
          ...(general.smtpPass ? { smtp_pass: general.smtpPass } : {}),
          mail_rate_limit: Number(general.mailRateLimit),
          mail_concurrency: Number(general.mailConcurrency),
          favicon_url: general.faviconUrl,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? t("settings.common.saveFailedFallback"));
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      if (general.smtpPass) patch({ smtpPass: "", smtpPassSet: true });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function testMail() {
    setMailTest(null);
    setError(null);
    setTestingMail(true);
    try {
      const res = await fetch("/api/settings/test-mail", { method: "POST" });
      const data = (await res.json()) as { error?: string; response?: string };
      if (!res.ok) {
        setMailTest(data.error ?? t("settings.mail.testFailedFallback"));
        return;
      }
      setMailTest(
        t("settings.mail.testSentMessage", {
          email: general.adminEmail,
          response: data.response ?? t("settings.mail.testResponseFallback"),
        }),
      );
    } catch (e) {
      setMailTest(String(e));
    } finally {
      setTestingMail(false);
    }
  }

  if (loading) {
    return (
      <div className="jf-page" aria-busy="true">
        <div className="jf-skeleton" style={{ height: 44, maxWidth: 260 }} />
        <div className="jf-skeleton" style={{ height: 260 }} />
      </div>
    );
  }

  const timezoneGroups = groupTimezones(timezones);
  const dateIsCustom =
    customDate || !(DATE_FORMAT_PRESETS as readonly string[]).includes(general.dateFormat);
  const timeIsCustom =
    customTime || !(TIME_FORMAT_PRESETS as readonly string[]).includes(general.timeFormat);

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("settings.pageTitle")}</h1>
          <p>{t("settings.pageSubtitle")}</p>
        </div>
      </header>

      {/* Native fieldset disabling covers every input/select/textarea/button
          below in one shot — cheaper and less error-prone than gating each
          of the dozens of controls in this form individually. */}
      <fieldset disabled={!canManage} style={{ border: 0, margin: 0, padding: 0 }}>
        <Section title={t("settings.general.siteIdentityTitle")}>
          <div className="jf-grid jf-grid--2">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-site-name">
                {t("settings.general.siteTitleLabel")}
              </label>
              <input
                id="jf-site-name"
                className="jf-input"
                value={general.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-site-url">
                {t("settings.general.siteUrlLabel")}
              </label>
              <input
                id="jf-site-url"
                className="jf-input"
                value={general.url}
                placeholder="https://example.com"
                onChange={(e) => patch({ url: e.target.value })}
              />
              <p className="jf-field__hint">{t("settings.general.siteUrlHint")}</p>
            </div>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-tagline">
              {t("settings.general.taglineLabel")}
            </label>
            <input
              id="jf-tagline"
              className="jf-input"
              value={general.description}
              placeholder={t("settings.general.taglinePlaceholder")}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <p className="jf-field__hint">{t("settings.general.taglineHint")}</p>
          </div>
          <MediaImageField
            id="jf-site-icon"
            label={t("settings.general.siteIconLabel")}
            description={t("settings.general.siteIconDescription")}
            value={general.faviconUrl}
            onChange={(url) => patch({ faviconUrl: url })}
            square
          />
        </Section>

        <Section title={t("settings.general.administrationTitle")}>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-admin-email">
              {t("settings.general.adminEmailLabel")}
            </label>
            <input
              id="jf-admin-email"
              className="jf-input"
              type="email"
              value={general.adminEmail}
              placeholder="admin@example.com"
              required
              onChange={(e) => patch({ adminEmail: e.target.value })}
            />
            <p className="jf-field__hint">{t("settings.general.adminEmailHint")}</p>
          </div>
        </Section>

        <Section title={t("settings.mail.title")}>
          <p className="jf-field__hint" style={{ marginTop: 0 }}>
            {t("settings.mail.transportHint")}
          </p>
          <div className="jf-grid jf-grid--2">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-mail-transport">
                {t("settings.mail.mailerLabel")}
              </label>
              <select
                id="jf-mail-transport"
                className="jf-input"
                value={general.mailTransport}
                onChange={(e) => patch({ mailTransport: e.target.value })}
              >
                {mailTransports.map((transport) => (
                  <option key={transport.id} value={transport.id}>
                    {transport.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-mail-from-name">
                {t("settings.mail.fromNameLabel")}
              </label>
              <input
                id="jf-mail-from-name"
                className="jf-input"
                value={general.mailFromName}
                placeholder={general.name || t("settings.mail.fromNameFallback")}
                onChange={(e) => patch({ mailFromName: e.target.value })}
              />
              <p className="jf-field__hint">{t("settings.mail.fromNameHint")}</p>
            </div>
          </div>
          <div className="jf-grid jf-grid--2">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-mail-from-address">
                {t("settings.mail.fromAddressLabel")}
              </label>
              <input
                id="jf-mail-from-address"
                className="jf-input"
                type="email"
                value={general.mailFromAddress}
                placeholder={general.adminEmail}
                onChange={(e) => patch({ mailFromAddress: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-mail-reply-to">
                {t("settings.mail.replyToLabel")}
              </label>
              <input
                id="jf-mail-reply-to"
                className="jf-input"
                type="email"
                value={general.mailReplyTo}
                onChange={(e) => patch({ mailReplyTo: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-mail-envelope">
                {t("settings.mail.envelopeSenderLabel")}
              </label>
              <input
                id="jf-mail-envelope"
                className="jf-input"
                type="email"
                value={general.mailEnvelopeSender}
                onChange={(e) => patch({ mailEnvelopeSender: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-mail-rate">
                {t("settings.mail.rateLabel")}
              </label>
              <div className="jf-row">
                <input
                  id="jf-mail-rate"
                  aria-label={t("settings.mail.rateAriaLabel")}
                  className="jf-input"
                  type="number"
                  min="1"
                  value={general.mailRateLimit}
                  onChange={(e) => patch({ mailRateLimit: e.target.value })}
                />
                <input
                  aria-label={t("settings.mail.concurrencyAriaLabel")}
                  className="jf-input"
                  type="number"
                  min="1"
                  value={general.mailConcurrency}
                  onChange={(e) => patch({ mailConcurrency: e.target.value })}
                />
              </div>
            </div>
          </div>
          {general.mailTransport === "smtp" && (
            <>
              <div className="jf-grid jf-grid--2">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-smtp-host">
                    {t("settings.mail.smtpHostLabel")}
                  </label>
                  <input
                    id="jf-smtp-host"
                    className="jf-input"
                    value={general.smtpHost}
                    placeholder="localhost"
                    onChange={(e) => patch({ smtpHost: e.target.value })}
                  />
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-smtp-port">
                    {t("settings.mail.portLabel")}
                  </label>
                  <input
                    id="jf-smtp-port"
                    className="jf-input"
                    type="number"
                    min={1}
                    max={65535}
                    value={general.smtpPort}
                    onChange={(e) => patch({ smtpPort: e.target.value })}
                  />
                </div>
              </div>
              <div className="jf-grid jf-grid--2">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-smtp-secure">
                    {t("settings.mail.encryptionLabel")}
                  </label>
                  <select
                    id="jf-smtp-secure"
                    className="jf-input"
                    value={general.smtpSecure}
                    onChange={(e) => {
                      const value = e.target.value;
                      patch({
                        smtpSecure: value === "starttls" || value === "ssl" ? value : "none",
                      });
                    }}
                  >
                    <option value="none">{t("settings.mail.encryptionNone")}</option>
                    <option value="starttls">{t("settings.mail.encryptionStarttls")}</option>
                    <option value="ssl">{t("settings.mail.encryptionSsl")}</option>
                  </select>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-smtp-user">
                    {t("settings.mail.usernameLabel")}
                  </label>
                  <input
                    id="jf-smtp-user"
                    className="jf-input"
                    value={general.smtpUser}
                    autoComplete="off"
                    onChange={(e) => patch({ smtpUser: e.target.value })}
                  />
                </div>
              </div>
              <div className="jf-field" style={{ maxWidth: 320 }}>
                <label className="jf-field__label" htmlFor="jf-smtp-pass">
                  {t("settings.mail.passwordLabel")}
                </label>
                <input
                  id="jf-smtp-pass"
                  className="jf-input"
                  type="password"
                  value={general.smtpPass}
                  autoComplete="new-password"
                  placeholder={general.smtpPassSet ? t("settings.mail.passwordStoredPlaceholder") : ""}
                  onChange={(e) => patch({ smtpPass: e.target.value })}
                />
              </div>
            </>
          )}
          <div className="jf-row">
            <button type="button" className="jf-btn" onClick={testMail} disabled={testingMail}>
              {testingMail ? t("settings.mail.sendingButton") : t("settings.mail.sendTestButton")}
            </button>
            {mailTest && <span className="jf-field__hint">{mailTest}</span>}
          </div>
          <p className="jf-field__hint">{t("settings.mail.testBeforeSaveHint")}</p>
          <p className="jf-field__hint">{t("settings.mail.dnsHint")}</p>
        </Section>

        <Section title={t("settings.membership.title")}>
          <label className="jf-checkrow">
            <input
              type="checkbox"
              checked={general.usersCanRegister}
              onChange={(e) => patch({ usersCanRegister: e.target.checked })}
            />
            <span>{t("settings.membership.allowRegistration")}</span>
          </label>
          <p className="jf-field__hint">
            {t("settings.membership.registrationHintBefore")} <code>/register</code>
            {t("settings.membership.registrationHintAfter")}
          </p>
          <div className="jf-field" style={{ maxWidth: 280 }}>
            <label className="jf-field__label" htmlFor="jf-default-role">
              {t("settings.membership.defaultRoleLabel")}
            </label>
            <select
              id="jf-default-role"
              className="jf-input"
              value={general.defaultRole}
              onChange={(e) => patch({ defaultRole: e.target.value })}
            >
              {(roleOptions.some((role) => role.id === general.defaultRole)
                ? roleOptions
                : [{ id: general.defaultRole, label: general.defaultRole }, ...roleOptions]
              ).map((role) => (
                <option key={role.id} value={role.id}>
                  {roleOptionLabel(role, t)}
                </option>
              ))}
            </select>
          </div>
        </Section>

        <Section title={t("settings.locale.languageSectionTitle")}>
          <div className="jf-field" style={{ maxWidth: 320 }}>
            <label className="jf-field__label" htmlFor="jf-site-language">
              {t("settings.locale.siteLanguageLabel")}
            </label>
            <select
              id="jf-site-language"
              className="jf-input"
              value={general.siteLanguage}
              onChange={(e) => patch({ siteLanguage: e.target.value })}
            >
              {(languages.length > 0
                ? languages
                : [
                    {
                      code: "en-US",
                      name: "English",
                      nativeName: "English",
                      isDefault: true,
                      isActive: true,
                    },
                  ]
              ).map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName} ({lang.code})
                </option>
              ))}
            </select>
            <p className="jf-field__hint">
              {t("settings.locale.siteLanguageHintBefore")}{" "}
              <a href={publicAdminPath("/admin/languages")}>{t("settings.locale.languagesLinkText")}</a>.
            </p>
          </div>
        </Section>

        <Section title={t("settings.locale.timezoneSectionTitle")}>
          <div className="jf-field" style={{ maxWidth: 420 }}>
            <label className="jf-field__label" htmlFor="jf-tz">
              {t("settings.locale.timezoneLabel")}
            </label>
            <select
              id="jf-tz"
              className="jf-input"
              value={general.timezone}
              onChange={(e) => patch({ timezone: e.target.value })}
            >
              {timezoneGroups.map((group) => (
                <optgroup key={group.region} label={group.region}>
                  {group.zones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, " ")}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="jf-field__hint">
              {t("settings.locale.universalTimeLabel")} <strong>{utcTime}</strong>.{" "}
              {t("settings.locale.localTimeLabel")} <strong>{localTime}</strong>.
            </p>
          </div>
        </Section>

        <Section title={t("settings.datetime.title")}>
          <FormatPicker
            legend={t("settings.datetime.dateFormatLegend")}
            name="date_format"
            presets={DATE_FORMAT_PRESETS}
            value={general.dateFormat}
            custom={dateIsCustom}
            preview={(fmt) => formatPhpDate(now, fmt, { timeZone: general.timezone })}
            onSelect={(fmt, isCustom) => {
              setCustomDate(isCustom);
              patch({ dateFormat: fmt });
            }}
          />
          <FormatPicker
            legend={t("settings.datetime.timeFormatLegend")}
            name="time_format"
            presets={TIME_FORMAT_PRESETS}
            value={general.timeFormat}
            custom={timeIsCustom}
            preview={(fmt) => formatPhpDate(now, fmt, { timeZone: general.timezone })}
            onSelect={(fmt, isCustom) => {
              setCustomTime(isCustom);
              patch({ timeFormat: fmt });
            }}
          />
          <div className="jf-field" style={{ maxWidth: 240 }}>
            <label className="jf-field__label" htmlFor="jf-week-start">
              {t("settings.datetime.weekStartLabel")}
            </label>
            <select
              id="jf-week-start"
              className="jf-input"
              value={general.startOfWeek}
              onChange={(e) => patch({ startOfWeek: Number(e.target.value) })}
            >
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          </div>
        </Section>

        <Section title={t("settings.visibility.title")}>
          <label className="jf-checkrow">
            <input
              type="checkbox"
              checked={general.sitePublic}
              onChange={(e) => patch({ sitePublic: e.target.checked })}
            />
            <span>{t("settings.visibility.siteLiveLabel")}</span>
          </label>
          <p className="jf-field__hint">{t("settings.visibility.siteLiveHint")}</p>

          <label className="jf-checkrow" style={{ marginTop: "1.25rem" }}>
            <input
              type="checkbox"
              checked={maintenance.enabled}
              disabled={!canManage || maintenanceSaving}
              onChange={(e) => void saveMaintenance({ ...maintenance, enabled: e.target.checked })}
            />
            <span>{t("settings.visibility.maintenanceModeLabel")}</span>
          </label>
          <p className="jf-field__hint">{t("settings.visibility.maintenanceModeHint")}</p>
          {maintenance.enabled && (
            <div className="jf-stack" style={{ gap: "0.75rem", marginTop: "0.5rem", maxWidth: 480 }}>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-maintenance-heading">
                  {t("settings.errorPages.headingLabel")}
                </label>
                <input
                  id="jf-maintenance-heading"
                  className="jf-input"
                  type="text"
                  maxLength={200}
                  value={maintenance.heading}
                  disabled={!canManage}
                  onChange={(e) => setMaintenance({ ...maintenance, heading: e.target.value })}
                  onBlur={() => void saveMaintenance(maintenance)}
                  placeholder={t("settings.errorPages.maintenanceHeadingPlaceholder")}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-maintenance-message">
                  {t("settings.errorPages.messageLabel")}
                </label>
                <textarea
                  id="jf-maintenance-message"
                  className="jf-input"
                  maxLength={2000}
                  rows={3}
                  value={maintenance.message}
                  disabled={!canManage}
                  onChange={(e) => setMaintenance({ ...maintenance, message: e.target.value })}
                  onBlur={() => void saveMaintenance(maintenance)}
                  placeholder={t("settings.errorPages.maintenanceMessagePlaceholder")}
                />
              </div>
              {maintenanceSaved && <p className="jf-field__hint">{t("settings.errorPages.savedNotice")}</p>}
            </div>
          )}

          <div className="jf-field" style={{ marginTop: "1.25rem" }}>
            <label className="jf-field__label">{t("settings.errorPages.serverErrorTitle")}</label>
            <p className="jf-field__hint" style={{ marginTop: 0 }}>
              {t("settings.errorPages.serverErrorHint")}
            </p>
            <div className="jf-stack" style={{ gap: "0.75rem", marginTop: "0.5rem", maxWidth: 480 }}>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-error500-heading">
                  {t("settings.errorPages.headingLabel")}
                </label>
                <input
                  id="jf-error500-heading"
                  className="jf-input"
                  type="text"
                  maxLength={200}
                  value={errorPage500.heading}
                  disabled={!canManage}
                  onChange={(e) => setErrorPage500({ ...errorPage500, heading: e.target.value })}
                  onBlur={() => void saveErrorPage500(errorPage500)}
                  placeholder={t("settings.errorPages.error500HeadingPlaceholder")}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-error500-message">
                  {t("settings.errorPages.messageLabel")}
                </label>
                <textarea
                  id="jf-error500-message"
                  className="jf-input"
                  maxLength={2000}
                  rows={3}
                  value={errorPage500.message}
                  disabled={!canManage}
                  onChange={(e) => setErrorPage500({ ...errorPage500, message: e.target.value })}
                  onBlur={() => void saveErrorPage500(errorPage500)}
                  placeholder={t("settings.errorPages.error500MessagePlaceholder")}
                />
              </div>
              {errorPage500Saving ? (
                <p className="jf-field__hint">{t("common.saving")}</p>
              ) : (
                errorPage500Saved && <p className="jf-field__hint">{t("settings.errorPages.savedNotice")}</p>
              )}
            </div>
          </div>
        </Section>

        <Section title={t("settings.searchEngines.title")}>
          <label className="jf-checkrow">
            <input
              type="checkbox"
              checked={general.discourageSearchEngines}
              onChange={(e) => patch({ discourageSearchEngines: e.target.checked })}
            />
            <span>{t("settings.searchEngines.discourageLabel")}</span>
          </label>
          <p className="jf-field__hint">
            {t("settings.searchEngines.discourageHintPrefix")} <code>noindex</code>{" "}
            {t("settings.searchEngines.discourageHintMiddle")} <code>robots.txt</code>
            {t("settings.searchEngines.discourageHintSuffix")}
          </p>
        </Section>

        <Section title={t("settings.reading.title")}>
          <div className="jf-field" style={{ maxWidth: 200 }}>
            <label className="jf-field__label" htmlFor="jf-ppp">
              {t("settings.reading.postsPerPageLabel")}
            </label>
            <input
              id="jf-ppp"
              className="jf-input"
              type="number"
              min={1}
              max={100}
              value={general.postsPerPage}
              onChange={(e) => patch({ postsPerPage: e.target.value })}
            />
            <p className="jf-field__hint">{t("settings.reading.postsUnit")}</p>
          </div>
        </Section>

        <Section title={t("settings.trash.title")}>
          <div className="jf-field" style={{ maxWidth: 240 }}>
            <label className="jf-field__label" htmlFor="jf-trash-retention">
              {t("settings.trash.retentionLabel")}
            </label>
            <input
              id="jf-trash-retention"
              className="jf-input"
              type="number"
              min={1}
              max={3650}
              value={general.trashRetentionDays}
              onChange={(e) => patch({ trashRetentionDays: e.target.value })}
            />
            <p className="jf-field__hint">{t("settings.trash.retentionUnit")}</p>
          </div>
        </Section>
      </fieldset>

      {canReadMail && <EmailOperations canRetry={canManageMail} />}

      {canManage && (
        <div className="jf-row">
          <button className="jf-btn jf-btn--primary" onClick={save} disabled={saving}>
            {saving ? t("common.saving") : t("settings.general.saveButton")}
          </button>
          {saved && <span className="jf-status jf-status--saved">{t("settings.general.savedStatus")}</span>}
          {error && <span className="jf-status jf-status--error">{error}</span>}
        </div>
      )}

      {canManage && <DiscussionSettings />}
    </div>
  );
}

type Delivery = {
  id: string;
  message_type: string;
  recipient_masked: string;
  subject: string;
  status: string;
  transport: string;
  attempts: number;
  provider_response: string | null;
  error_detail: string | null;
  created_at: string;
};

function EmailOperations({ canRetry }: { canRetry: boolean }) {
  const { t } = useT();
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function load() {
    const response = await fetch(
      `/api/settings/email/logs${filter ? `?status=${encodeURIComponent(filter)}` : ""}`,
    );
    const data = (await response.json()) as { deliveries?: Delivery[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? t("settings.emailLog.loadFailedFallback"));
    setDeliveries(data.deliveries ?? []);
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [filter]);
  async function retry(id: string) {
    const response = await fetch(`/api/settings/email/logs/${id}/retry`, { method: "POST" });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) setError(data.error ?? t("settings.emailLog.retryFailedFallback"));
    else await load();
  }
  return (
    <Section title={t("settings.emailLog.title")}>
      <div className="jf-row">
        <label className="jf-field__label" htmlFor="jf-mail-status">
          {t("settings.emailLog.statusLabel")}
        </label>
        <select
          id="jf-mail-status"
          className="jf-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">{t("settings.emailLog.statusAll")}</option>
          <option value="queued">{t("settings.emailLog.statusQueued")}</option>
          <option value="sent">{t("settings.emailLog.statusSent")}</option>
          <option value="deferred">{t("settings.emailLog.statusDeferred")}</option>
          <option value="failed">{t("settings.emailLog.statusFailed")}</option>
        </select>
        <button type="button" className="jf-btn" onClick={() => void load()}>
          {t("settings.emailLog.refreshButton")}
        </button>
      </div>
      {error && (
        <p role="alert" className="jf-error">
          {error}
        </p>
      )}
      {deliveries.length === 0 ? (
        <p className="jf-field__hint">{t("settings.emailLog.emptyState")}</p>
      ) : (
        <div className="jf-table-wrap">
          <table className="jf-table">
            <thead>
              <tr>
                <th>{t("settings.emailLog.columnWhen")}</th>
                <th>{t("settings.emailLog.columnTypeRecipient")}</th>
                <th>{t("settings.emailLog.columnSubject")}</th>
                <th>{t("settings.emailLog.statusLabel")}</th>
                <th>{t("settings.emailLog.columnTransportResponse")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>
                    {row.message_type}
                    <br />
                    <span className="jf-meta">{row.recipient_masked}</span>
                  </td>
                  <td>{row.subject}</td>
                  <td>
                    {row.status} ({row.attempts})
                  </td>
                  <td>{row.error_detail ?? row.provider_response ?? t("settings.emailLog.noResponseFallback")}</td>
                  <td>
                    {canRetry && row.status !== "sent" && (
                      <button type="button" className="jf-btn" onClick={() => void retry(row.id)}>
                        {t("settings.emailLog.retryButton")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

type CommentSettingsState = {
  enabled: boolean;
  requireModeration: boolean;
  closeAfterDays: number;
  allowUrls: boolean;
  notifyModerator: boolean;
  maxLength: number;
  threadMaxDepth: number;
  pageSize: number;
  captchaProvider: "none" | "turnstile" | "hcaptcha" | "recaptcha" | "recaptcha-v3";
  captchaSiteKey: string;
  captchaScoreThreshold: number;
  captchaSecretKeySet: boolean;
  spamHoldThreshold: number;
  spamRejectThreshold: number;
  minRenderAgeSeconds: number;
  linkThreshold: number;
  firstCommentHold: boolean;
  autoApprovePreviouslyApproved: boolean;
  spamRetentionDays: number;
};

const DISCUSSION_DEFAULTS: CommentSettingsState = {
  enabled: false,
  requireModeration: true,
  closeAfterDays: 0,
  allowUrls: true,
  notifyModerator: true,
  maxLength: 5000,
  threadMaxDepth: 6,
  pageSize: 50,
  captchaProvider: "none",
  captchaSiteKey: "",
  captchaScoreThreshold: 0.5,
  captchaSecretKeySet: false,
  spamHoldThreshold: 40,
  spamRejectThreshold: 75,
  minRenderAgeSeconds: 3,
  linkThreshold: 2,
  firstCommentHold: false,
  autoApprovePreviouslyApproved: false,
  spamRetentionDays: 30,
};

function DiscussionSettings() {
  const { t } = useT();
  const [state, setState] = useState<CommentSettingsState>(DISCUSSION_DEFAULTS);
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/comments")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("ui.settingsPage.loadFailed")))))
      .then((data: Partial<CommentSettingsState>) => {
        if (!cancelled) setState({ ...DISCUSSION_DEFAULTS, ...data });
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function patch(next: Partial<CommentSettingsState>) {
    setState((s) => ({ ...s, ...next }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { ...state };
      delete payload.captchaSecretKeySet;
      if (secret) payload.captchaSecretKey = secret;
      const res = await fetch("/api/settings/comments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? t("settings.common.saveFailedFallback"));
        return;
      }
      setState({ ...DISCUSSION_DEFAULTS, ...data });
      setSecret("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError(t("settings.common.saveFailedFallback"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
      <Section title={t("settings.discussion.title")}>
        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>{t("settings.discussion.allowComments")}</span>
        </label>
        <p className="jf-field__hint">{t("settings.discussion.allowCommentsHint")}</p>

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={state.requireModeration}
            onChange={(e) => patch({ requireModeration: e.target.checked })}
          />
          <span>{t("settings.discussion.requireModeration")}</span>
        </label>

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={state.notifyModerator}
            onChange={(e) => patch({ notifyModerator: e.target.checked })}
          />
          <span>{t("settings.discussion.notifyModerator")}</span>
        </label>

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={state.allowUrls}
            onChange={(e) => patch({ allowUrls: e.target.checked })}
          />
          <span>{t("settings.discussion.allowUrls")}</span>
        </label>

        <div className="jf-grid jf-grid--2">
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-close">
              {t("settings.discussion.closeAfterLabel")}
            </label>
            <input
              id="jf-c-close"
              className="jf-input"
              type="number"
              min={0}
              max={3650}
              value={state.closeAfterDays}
              onChange={(e) => patch({ closeAfterDays: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.discussion.closeAfterUnit")}</p>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-page">
              {t("settings.discussion.pageSizeLabel")}
            </label>
            <input
              id="jf-c-page"
              className="jf-input"
              type="number"
              min={5}
              max={200}
              value={state.pageSize}
              onChange={(e) => patch({ pageSize: Number(e.target.value) })}
            />
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-max">
              {t("settings.discussion.maxLengthLabel")}
            </label>
            <input
              id="jf-c-max"
              className="jf-input"
              type="number"
              min={200}
              max={20000}
              value={state.maxLength}
              onChange={(e) => patch({ maxLength: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.discussion.maxLengthUnit")}</p>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-depth">
              {t("settings.discussion.maxDepthLabel")}
            </label>
            <input
              id="jf-c-depth"
              className="jf-input"
              type="number"
              min={1}
              max={10}
              value={state.threadMaxDepth}
              onChange={(e) => patch({ threadMaxDepth: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="jf-field">
          <label className="jf-field__label" htmlFor="jf-c-captcha">
            {t("settings.discussion.captchaLabel")}
          </label>
          <select
            id="jf-c-captcha"
            className="jf-input"
            value={state.captchaProvider}
            onChange={(e) =>
              patch({ captchaProvider: e.target.value as CommentSettingsState["captchaProvider"] })
            }
          >
            <option value="none">{t("settings.discussion.captchaOptionNone")}</option>
            <option value="turnstile">{t("settings.discussion.captchaOptionTurnstile")}</option>
            <option value="hcaptcha">{t("settings.discussion.captchaOptionHcaptcha")}</option>
            <option value="recaptcha">{t("settings.discussion.captchaOptionRecaptcha")}</option>
            <option value="recaptcha-v3">{t("settings.discussion.captchaOptionRecaptchaV3")}</option>
          </select>
          <p className="jf-field__hint">{t("settings.discussion.captchaHint")}</p>
        </div>
        {state.captchaProvider !== "none" && (
          <div className="jf-grid jf-grid--2">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-c-site">
                {t("settings.discussion.siteKeyLabel")}
              </label>
              <input
                id="jf-c-site"
                className="jf-input"
                type="text"
                value={state.captchaSiteKey}
                onChange={(e) => patch({ captchaSiteKey: e.target.value })}
              />
            </div>
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-c-secret">
                {t("settings.discussion.secretKeyLabel")}
              </label>
              <input
                id="jf-c-secret"
                className="jf-input"
                type="password"
                placeholder={state.captchaSecretKeySet ? t("settings.discussion.secretKeyPlaceholder") : ""}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <p className="jf-field__hint">{t("settings.discussion.secretKeyHint")}</p>
            </div>
          </div>
        )}
        {state.captchaProvider === "recaptcha-v3" && (
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-score">
              {t("settings.discussion.minScoreLabel")}
            </label>
            <input
              id="jf-c-score"
              className="jf-input"
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={state.captchaScoreThreshold}
              onChange={(e) => patch({ captchaScoreThreshold: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.discussion.minScoreHint")}</p>
          </div>
        )}

        <div className="jf-row" style={{ marginTop: "1rem" }}>
          <button className="jf-btn jf-btn--primary" onClick={save} disabled={saving}>
            {saving ? t("common.saving") : t("settings.discussion.saveButton")}
          </button>
          {saved && <span className="jf-status jf-status--saved">{t("settings.discussion.savedStatus")}</span>}
          {error && <span className="jf-status jf-status--error">{error}</span>}
        </div>
      </Section>

      <Section title={t("settings.spam.title")}>
        <p className="jf-field__hint">{t("settings.spam.heuristicHint")}</p>
        <div className="jf-grid jf-grid--2">
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-hold">
              {t("settings.spam.holdThresholdLabel")}
            </label>
            <input
              id="jf-c-hold"
              className="jf-input"
              type="number"
              min={0}
              max={100}
              value={state.spamHoldThreshold}
              onChange={(e) => patch({ spamHoldThreshold: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.spam.holdThresholdHint")}</p>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-reject">
              {t("settings.spam.rejectThresholdLabel")}
            </label>
            <input
              id="jf-c-reject"
              className="jf-input"
              type="number"
              min={0}
              max={100}
              value={state.spamRejectThreshold}
              onChange={(e) => patch({ spamRejectThreshold: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.spam.rejectThresholdHint")}</p>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-render-age">
              {t("settings.spam.minRenderAgeLabel")}
            </label>
            <input
              id="jf-c-render-age"
              className="jf-input"
              type="number"
              min={0}
              max={60}
              value={state.minRenderAgeSeconds}
              onChange={(e) => patch({ minRenderAgeSeconds: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.spam.minRenderAgeHint")}</p>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-links">
              {t("settings.spam.linkThresholdLabel")}
            </label>
            <input
              id="jf-c-links"
              className="jf-input"
              type="number"
              min={1}
              max={20}
              value={state.linkThreshold}
              onChange={(e) => patch({ linkThreshold: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.spam.linkThresholdHint")}</p>
          </div>
          <div className="jf-field">
            <label className="jf-field__label" htmlFor="jf-c-retention">
              {t("settings.spam.retentionLabel")}
            </label>
            <input
              id="jf-c-retention"
              className="jf-input"
              type="number"
              min={1}
              max={3650}
              value={state.spamRetentionDays}
              onChange={(e) => patch({ spamRetentionDays: Number(e.target.value) })}
            />
            <p className="jf-field__hint">{t("settings.spam.retentionHint")}</p>
          </div>
        </div>

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={state.firstCommentHold}
            onChange={(e) => patch({ firstCommentHold: e.target.checked })}
          />
          <span>{t("settings.spam.firstCommentHold")}</span>
        </label>

        <label className="jf-checkrow">
          <input
            type="checkbox"
            checked={state.autoApprovePreviouslyApproved}
            onChange={(e) => patch({ autoApprovePreviouslyApproved: e.target.checked })}
          />
          <span>{t("settings.spam.autoApprovePreviouslyApproved")}</span>
        </label>

        <div className="jf-row" style={{ marginTop: "1rem" }}>
          <button className="jf-btn jf-btn--primary" onClick={save} disabled={saving}>
            {saving ? t("common.saving") : t("settings.discussion.saveButton")}
          </button>
          {saved && <span className="jf-status jf-status--saved">{t("settings.discussion.savedStatus")}</span>}
          {error && <span className="jf-status jf-status--error">{error}</span>}
        </div>
      </Section>

      <ModerationRulesManager />
      <SpamTermsManager />
    </fieldset>
  );
}

interface ModerationRule {
  id: string;
  list: "block" | "allow";
  field: "author_email" | "author_domain" | "ip" | "phrase";
  pattern: string;
  note: string | null;
  hitCount: number;
}

const RULE_FIELD_KEYS: Record<ModerationRule["field"], string> = {
  author_email: "authorEmail",
  author_domain: "domain",
  ip: "ip",
  phrase: "phrase",
};

function ModerationRulesManager() {
  const { t } = useT();
  const [rules, setRules] = useState<ModerationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<ModerationRule["list"]>("block");
  const [field, setField] = useState<ModerationRule["field"]>("author_domain");
  const [pattern, setPattern] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldLabel = (f: ModerationRule["field"]) => t(`settings.moderationRules.fields.${RULE_FIELD_KEYS[f]}`);

  function load() {
    setLoading(true);
    fetch("/api/comment-rules")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("ui.settingsPage.loadFailed")))))
      .then((data: { rules: ModerationRule[] }) => setRules(data.rules ?? []))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function addRule() {
    if (!pattern.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/comment-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ list, field, pattern: pattern.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? t("settings.moderationRules.addFailedFallback"));
        return;
      }
      setPattern("");
      load();
    } catch {
      setError(t("settings.moderationRules.addFailedFallback"));
    }
  }

  async function removeRule(id: string) {
    await fetch(`/api/comment-rules/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <Section title={t("settings.moderationRules.title")}>
      <p className="jf-field__hint">{t("settings.moderationRules.hint")}</p>
      <div className="jf-row" style={{ gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <select
          className="jf-input"
          value={list}
          onChange={(e) => setList(e.target.value as ModerationRule["list"])}
        >
          <option value="block">{t("settings.moderationRules.listBlock")}</option>
          <option value="allow">{t("settings.moderationRules.listAllow")}</option>
        </select>
        <select
          className="jf-input"
          value={field}
          onChange={(e) => setField(e.target.value as ModerationRule["field"])}
        >
          <option value="author_email">{t("settings.moderationRules.fields.authorEmail")}</option>
          <option value="author_domain">{t("settings.moderationRules.fields.domain")}</option>
          <option value="ip">{t("settings.moderationRules.fields.ip")}</option>
          <option value="phrase">{t("settings.moderationRules.fields.phrase")}</option>
        </select>
        <input
          className="jf-input"
          style={{ flex: 1, minWidth: "12rem" }}
          placeholder={t("settings.moderationRules.patternPlaceholder")}
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
        />
        <button className="jf-btn" onClick={addRule}>
          {t("settings.moderationRules.addButton")}
        </button>
      </div>
      {error && <p className="jf-status jf-status--error">{error}</p>}
      {loading ? null : rules.length === 0 ? (
        <p className="jf-field__hint">{t("settings.moderationRules.emptyState")}</p>
      ) : (
        <table className="jf-table">
          <thead>
            <tr>
              <th>{t("settings.moderationRules.columnList")}</th>
              <th>{t("settings.moderationRules.columnField")}</th>
              <th>{t("settings.moderationRules.columnPattern")}</th>
              <th>{t("settings.moderationRules.columnHits")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.list}</td>
                <td>{fieldLabel(r.field)}</td>
                <td>{r.pattern}</td>
                <td>{r.hitCount}</td>
                <td>
                  <button className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => removeRule(r.id)}>
                    {t("settings.moderationRules.removeButton")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

interface SpamTerm {
  id: string;
  kind: "domain" | "phrase";
  value: string;
  weight: number;
  hits: number;
  source: "trained" | "manual";
}

function SpamTermsManager() {
  const { t } = useT();
  const [terms, setTerms] = useState<SpamTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<SpamTerm["kind"]>("phrase");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetch("/api/comment-spam-terms")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(t("ui.settingsPage.loadFailed")))))
      .then((data: { terms: SpamTerm[] }) => setTerms(data.terms ?? []))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function addTerm() {
    if (!value.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/comment-spam-terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, value: value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? t("settings.spamTerms.addFailedFallback"));
        return;
      }
      setValue("");
      load();
    } catch {
      setError(t("settings.spamTerms.addFailedFallback"));
    }
  }

  async function removeTerm(id: string) {
    await fetch(`/api/comment-spam-terms/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <Section title={t("settings.spamTerms.title")}>
      <p className="jf-field__hint">{t("settings.spamTerms.hint")}</p>
      <div className="jf-row" style={{ gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <select className="jf-input" value={kind} onChange={(e) => setKind(e.target.value as SpamTerm["kind"])}>
          <option value="phrase">{t("settings.spamTerms.kindPhrase")}</option>
          <option value="domain">{t("settings.spamTerms.kindDomain")}</option>
        </select>
        <input
          className="jf-input"
          style={{ flex: 1, minWidth: "12rem" }}
          placeholder={kind === "domain" ? "spam4free.example" : t("ui.settingsPage.freeCrypto")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="jf-btn" onClick={addTerm}>
          {t("settings.spamTerms.addButton")}
        </button>
      </div>
      {error && <p className="jf-status jf-status--error">{error}</p>}
      {loading ? null : terms.length === 0 ? (
        <p className="jf-field__hint">{t("settings.spamTerms.emptyState")}</p>
      ) : (
        <table className="jf-table">
          <thead>
            <tr>
              <th>{t("settings.spamTerms.columnKind")}</th>
              <th>{t("settings.spamTerms.columnValue")}</th>
              <th>{t("settings.spamTerms.columnWeight")}</th>
              <th>{t("settings.spamTerms.columnSource")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {terms.map((term) => (
              <tr key={term.id}>
                <td>{term.kind}</td>
                <td>{term.value}</td>
                <td>{term.weight}</td>
                <td>{term.source === "manual" ? t("settings.spamTerms.sourceManual") : t("settings.spamTerms.sourceLearned")}</td>
                <td>
                  <button className="jf-btn jf-btn--ghost jf-btn--sm" onClick={() => removeTerm(term.id)}>
                    {t("settings.spamTerms.removeButton")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function FormatPicker({
  legend,
  name,
  presets,
  value,
  custom,
  preview,
  onSelect,
}: {
  legend: string;
  name: string;
  presets: readonly string[];
  value: string;
  custom: boolean;
  preview: (format: string) => string;
  onSelect: (format: string, custom: boolean) => void;
}) {
  const { t } = useT();
  return (
    <fieldset className="jf-choice">
      <legend className="jf-field__label">{legend}</legend>
      {presets.map((fmt) => (
        <label key={fmt} className="jf-checkrow">
          <input
            type="radio"
            name={name}
            checked={!custom && value === fmt}
            onChange={() => onSelect(fmt, false)}
          />
          <code className="jf-code">{fmt}</code>
          <span className="jf-checkrow__meta">{preview(fmt)}</span>
        </label>
      ))}
      <label className="jf-checkrow">
        <input type="radio" name={name} checked={custom} onChange={() => onSelect(value, true)} />
        <span>{t("settings.datetime.customLabel")}</span>
        <input
          className="jf-input"
          style={{ maxWidth: 180 }}
          value={custom ? value : ""}
          placeholder={presets[0]}
          aria-label={t("settings.datetime.customAriaLabel", { legend: legend.toLowerCase() })}
          onFocus={() => onSelect(value || presets[0]!, true)}
          onChange={(e) => onSelect(e.target.value, true)}
        />
        {custom && value && <span className="jf-checkrow__meta">{preview(value)}</span>}
      </label>
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">{title}</h2>
      </div>
      <div className="jf-card__body jf-stack">{children}</div>
    </div>
  );
}
