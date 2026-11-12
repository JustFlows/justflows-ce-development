/**
 * Justflows install wizard.
 */
import { cloneElement, isValidElement, useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "../admin-router";
import { JustflowsLogo } from "@components/JustflowsLogo";
import {
  DEFAULT_CONTENT_LOCALE,
  INSTALL_LOCALE_CODES,
  metaForCode,
  normalizeLocale,
} from "@lib/i18n/locales";
import { useT } from "../i18n/I18nProvider";

type Step = "preparing" | "welcome" | "database" | "site" | "account" | "installing" | "done";

const STEP_LABEL_KEYS: Record<"welcome" | "database" | "site" | "account", string> = {
  welcome: "install.steps.welcome",
  database: "install.steps.database",
  site: "install.steps.site",
  account: "install.steps.account",
};

interface DbForm {
  driver: "postgres" | "mysql" | "mariadb";
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

interface SiteForm {
  name: string;
  description: string;
}

interface AccountForm {
  email: string;
  username: string;
  displayName: string;
  password: string;
  confirmPassword: string;
  emailDetails: boolean;
}

interface InstallLog {
  message: string;
  status: "running" | "ok" | "error";
}

const OTHER_LOCALE = "__other__";

type InstallHost = "plesk" | "cpanel";

const HOST_LABELS: Record<InstallHost, string> = {
  plesk: "Plesk",
  cpanel: "cPanel",
};

function parseInstallHost(value: unknown): InstallHost | null {
  return value === "plesk" || value === "cpanel" ? value : null;
}

/**
 * Reads a setup key a hosting panel passed in the URL fragment
 * (`/install#setup-key=…`) and removes the fragment at once, so the key does
 * not stay in the address bar or the history entry. A fragment is never sent
 * to a server or in a Referer header.
 */
function takeSetupKeyFromFragment(): string | null {
  if (typeof window === "undefined" || !window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const key = params.get("setup-key");
  if (key === null) return null;
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  return /^[A-Za-z0-9_-]{16,128}$/.test(key) ? key : null;
}

const DRIVER_LABELS: Record<DbForm["driver"], string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
};

function localeOptionLabel(code: string): string {
  const meta = metaForCode(code);
  if (meta.name === meta.nativeName) return `${meta.name} — ${code}`;
  return `${meta.name} (${meta.nativeName}) — ${code}`;
}

const DEFAULT_PORTS: Record<DbForm["driver"], string> = {
  postgres: "5432",
  mysql: "3306",
  mariadb: "3306",
};

export default function InstallPage() {
  const { t } = useT();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("welcome");
  const [log, setLog] = useState<InstallLog[]>([]);
  const [fatalError, setFatalError] = useState("");

  const [db, setDb] = useState<DbForm>({
    driver: "mysql",
    host: "localhost",
    port: "3306",
    database: "justflows",
    username: "",
    password: "",
  });

  const [site, setSite] = useState<SiteForm>({ name: "", description: "" });
  const [localeChoice, setLocaleChoice] = useState<string>(DEFAULT_CONTENT_LOCALE);
  const [customLocale, setCustomLocale] = useState("");
  const [installTokenValue, setInstallTokenValue] = useState("");
  const [tokenRequired, setTokenRequired] = useState(false);
  const [tokenFile, setTokenFile] = useState<string | null>(null);
  const [bootstrapLog, setBootstrapLog] = useState("");
  /**
   * Set when the host already created the database (`DB_PROVISIONED=true`).
   * The server keeps the credentials; the wizard only knows the driver.
   */
  const [dbProvisioned, setDbProvisioned] = useState<DbForm["driver"] | null>(null);
  const [provisionChecked, setProvisionChecked] = useState(false);
  /** The hosting panel that installed this site, when it says so (`INSTALL_HOST`). */
  const [installHost, setInstallHost] = useState<InstallHost | null>(null);
  /** A key passed by the panel; it is only filled in once a known host is confirmed. */
  const pendingSetupKey = useRef<string | null>(null);
  const [keyFromHost, setKeyFromHost] = useState(false);

  useEffect(() => {
    /** Keep the first read: the fragment is gone after it (and StrictMode runs effects twice). */
    const key = takeSetupKeyFromFragment();
    if (key) pendingSetupKey.current = key;
  }, []);

  /** Records the host and, for a known host, fills in the key it passed. */
  function applyInstallHost(value: unknown) {
    const host = parseInstallHost(value);
    setInstallHost(host);
    const key = pendingSetupKey.current;
    if (host && key) {
      pendingSetupKey.current = null;
      setInstallTokenValue((current) => (current.trim() ? current : key));
      setKeyFromHost(true);
    }
  }

  // First-run zip installs download npm packages before the site wizard. Do not
  // collect database details — and never POST /api/install — until that finishes.
  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function pollBootstrap() {
      try {
        const res = await fetch("/api/bootstrap/status");
        if (cancelled) return;
        if (res.status === 404) return;
        const body = (await res.json()) as {
          ready?: boolean;
          installed?: boolean;
          log?: string;
        };
        if (cancelled) return;
        if (body.installed) return;
        if (body.ready === false) {
          setBootstrapLog(body.log ?? "");
          setStep((current) =>
            current === "installing" || current === "done" ? current : "preparing",
          );
          timer = window.setTimeout(pollBootstrap, 1500);
          return;
        }
        setStep((current) => (current === "preparing" ? "welcome" : current));
      } catch {
        // Express-only `pnpm dev` has no bootstrap API; the wizard can continue.
      }
    }

    void pollBootstrap();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  /**
   * Asked once the dependency check has finished, so it never boots the app
   * any earlier than the welcome step already does.
   */
  useEffect(() => {
    if (step !== "welcome" || provisionChecked) return;
    setProvisionChecked(true);
    fetch("/api/install/status")
      .then((r) => r.json())
      .then((data: { databaseProvisioned?: boolean; databaseDriver?: string | null; installHost?: string | null }) => {
        applyInstallHost(data.installHost);
        const driver = data.databaseDriver;
        if (data.databaseProvisioned && (driver === "postgres" || driver === "mysql" || driver === "mariadb")) {
          setDbProvisioned(driver);
        }
      })
      .catch(() => {
        /** Without the answer the wizard simply asks for the database. */
      });
  }, [step, provisionChecked]);

  /** Switches from the host's database to entering details by hand. */
  function switchToOwnDatabase() {
    setDbProvisioned(null);
    setStep("database");
  }

  // Token check belongs on the last form step so visiting Database / Site does
  // not boot the full app or generate TOKEN.txt.
  useEffect(() => {
    if (step !== "account") return;
    fetch("/api/install/status")
      .then((r) => r.json())
      .then((data: { tokenRequired?: boolean; tokenFile?: string | null; installHost?: string | null }) => {
        setTokenRequired(Boolean(data.tokenRequired));
        setTokenFile(data.tokenFile ?? null);
        applyInstallHost(data.installHost);
      })
      .catch(() => {
        setTokenRequired(true);
      });
  }, [step]);
  const [account, setAccount] = useState<AccountForm>({
    email: "",
    username: "admin",
    displayName: "",
    password: "",
    confirmPassword: "",
    emailDetails: true,
  });

  // ── derived ──────────────────────────────────────────────────────────────
  const siteUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}${window.location.port ? `:${window.location.port}` : ""}`
      : "";

  const resolvedLocale =
    localeChoice === OTHER_LOCALE
      ? normalizeLocale(customLocale)
      : localeChoice;
  const customLocalePreview = localeChoice === OTHER_LOCALE ? metaForCode(customLocale.trim()) : null;
  const canContinueSite = Boolean(site.name) && Boolean(resolvedLocale);

  const passwordsMatch =
    account.password.length === 0 ||
    account.confirmPassword.length === 0 ||
    account.password === account.confirmPassword;

  const canInstall =
    account.email.includes("@") &&
    account.username.length >= 2 &&
    account.displayName.length > 0 &&
    (!tokenRequired || installTokenValue.trim().length > 0) &&
    account.password.length >= 12 &&
    account.password === account.confirmPassword;

  /** How to find the key in the site's files; shared by both callouts. */
  const setupKeyFileSteps = (
    <>
      <ol className="jf-callout__steps">
        <li>{t("install.account.setupKeyStep1")}</li>
        <li>
          {t("install.account.setupKeyStep2Before")}{" "}
          <code>{tokenFile ? tokenFile.split("/")[0] : "install-token"}</code>{" "}
          {t("install.account.setupKeyStep2Between")} <code>TOKEN.txt</code>.
        </li>
        <li>{t("install.account.setupKeyStep3")}</li>
      </ol>
      <p className="jf-callout__note">{t("install.account.setupKeyNote1")}</p>
      <p className="jf-callout__note">{t("install.account.setupKeyNote2")}</p>
    </>
  );

  // ── install ───────────────────────────────────────────────────────────────
  async function runInstall() {
    if (!canInstall) return;

    try {
      const bootstrap = await fetch("/api/bootstrap/status");
      if (bootstrap.ok) {
        const body = (await bootstrap.json()) as { ready?: boolean; log?: string };
        if (body.ready === false) {
          setBootstrapLog(body.log ?? "");
          setStep("preparing");
          return;
        }
      }
    } catch {
      // Express-only dev has no bootstrap API.
    }

    setStep("installing");
    setLog([]);
    setFatalError("");

    function addLog(message: string, status: InstallLog["status"] = "running") {
      setLog((prev) => [...prev, { message, status }]);
    }

    function markLast(status: InstallLog["status"]) {
      setLog((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, status };
        return next;
      });
    }

    try {
      addLog(t("install.installing.connectingLog"));
      const res = await fetch("/api/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: installTokenValue.trim(),
          db: dbProvisioned
            ? undefined
            : {
                driver: db.driver,
                host: db.host,
                port: Number(db.port),
                database: db.database,
                username: db.username,
                password: db.password,
              },
          site: {
            name: site.name,
            description: site.description,
            url: siteUrl,
            locale: resolvedLocale ?? DEFAULT_CONTENT_LOCALE,
          },
          account: {
            email: account.email,
            username: account.username,
            displayName: account.displayName,
            password: account.password,
            emailDetails: account.emailDetails,
          },
        }),
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const text = await res.text();
        let message = text.trim() || t("install.installing.failedWithStatus", { status: res.status });
        try {
          const json = JSON.parse(text) as { message?: string; error?: string };
          if (json.error === "not_ready") {
            setStep("preparing");
            return;
          }
          message = json.message || json.error || message;
        } catch {
          // Use the raw body.
        }
        throw new Error(message);
      }

      // Stream log events from the response body
      if (!res.body) throw new Error(t("install.installing.noResponseBody"));

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw) continue;

          try {
            const event = JSON.parse(raw) as {
              type: "step" | "done" | "error";
              message: string;
            };

            if (event.type === "step") {
              markLast("ok");
              addLog(event.message);
            } else if (event.type === "done") {
              markLast("ok");
              // Ask the server to set the jf_installed cookie via Set-Cookie header
              // This is more reliable than document.cookie across all hosting environments
              await fetch("/api/install/complete").catch(() => null);
              setStep("done");
            } else if (event.type === "error") {
              markLast("error");
              setFatalError(event.message);
              setStep("installing"); // stay on log view, show error
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : String(err));
      markLast("error");
    }
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="jf-auth">
      <div className="jf-auth__card jf-auth__card--wide">
        <div className="jf-auth__head">
          <div className="jf-auth__brand">
            <JustflowsLogo />
            Justflows
          </div>
          <h1 className="jf-auth__sub">{t("install.title")}</h1>
        </div>

        {/* Progress dots */}
        {step !== "preparing" && step !== "installing" && step !== "done" && (
          <ol className="jf-steps" aria-label={t("install.stepsAriaLabel")}>
            {(dbProvisioned
              ? (["welcome", "site", "account"] as const)
              : (["welcome", "database", "site", "account"] as const)
            ).map((s) => (
              <li
                key={s}
                className="jf-steps__dot"
                data-current={s === step}
                aria-current={s === step ? "step" : undefined}
              >
                <span className="jf-sr-only">{t(STEP_LABEL_KEYS[s])}</span>
              </li>
            ))}
          </ol>
        )}

        <div className="jf-auth__body">
          {/* ── PREPARING (first-run npm install) ──────────────────────── */}
          {step === "preparing" && (
            <div className="jf-stack">
              <h2 className="jf-section-title">{t("install.preparing.heading")}</h2>
              <p className="jf-prose">{t("install.preparing.body")}</p>
              {bootstrapLog ? (
                <div className="jf-log" role="log" aria-live="polite" aria-relevant="additions">
                  <pre className="jf-log__line" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                    {bootstrapLog}
                  </pre>
                </div>
              ) : null}
            </div>
          )}

          {/* ── WELCOME ─────────────────────────────────────────────────── */}
          {step === "welcome" && (
            <div className="jf-stack">
              <h2 className="jf-section-title">{t("install.welcome.heading")}</h2>
              <p className="jf-prose">{t("install.welcome.intro")}</p>
              <ul className="jf-prose" style={{ paddingInlineStart: "1.25rem", lineHeight: 2 }}>
                {dbProvisioned ? null : (
                  <>
                    <li>{t("install.welcome.needDatabase")}</li>
                    <li>{t("install.welcome.needDbDetails")}</li>
                  </>
                )}
                <li>{t("install.welcome.needLanguage")}</li>
                <li>{t("install.welcome.needEmail")}</li>
              </ul>
              {dbProvisioned ? (
                <div className="jf-callout" role="note">
                  <p className="jf-callout__title">
                    {t("install.welcome.databaseProvided", { driver: DRIVER_LABELS[dbProvisioned] })}
                  </p>
                  <button className="jf-btn jf-btn--ghost" onClick={switchToOwnDatabase}>
                    {t("install.welcome.useOwnDatabase")}
                  </button>
                </div>
              ) : null}
              <p className="jf-prose">{t("install.welcome.outro")}</p>
              <button className="jf-btn jf-btn--primary" onClick={() => setStep(dbProvisioned ? "site" : "database")}>
                {t("install.welcome.cta")}
              </button>
            </div>
          )}

          {/* ── DATABASE ────────────────────────────────────────────────── */}
          {step === "database" && (
            <div className="jf-stack">
              <h2 className="jf-section-title">{t("install.database.heading")}</h2>
              <p className="jf-prose">{t("install.database.intro")}</p>

              <Field label={t("install.database.typeLabel")}>
                <select
                  className="jf-input"
                  value={db.driver}
                  onChange={(e) => {
                    const driver = e.target.value as DbForm["driver"];
                    setDb((d) => ({
                      ...d,
                      driver,
                      port: DEFAULT_PORTS[driver],
                    }));
                  }}
                >
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="mariadb">MariaDB</option>
                </select>
              </Field>

              <div className="jf-grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(90px, 120px)" }}>
                <Field label={t("install.database.hostLabel")}>
                  <input
                    className="jf-input"
                    value={db.host}
                    placeholder="localhost"
                    onChange={(e) => setDb((d) => ({ ...d, host: e.target.value }))}
                  />
                </Field>
                <Field label={t("install.database.portLabel")}>
                  <input
                    className="jf-input"
                    value={db.port}
                    onChange={(e) => setDb((d) => ({ ...d, port: e.target.value }))}
                  />
                </Field>
              </div>

              <Field label={t("install.database.nameLabel")}>
                <input
                  className="jf-input"
                  value={db.database}
                  placeholder="justflows"
                  onChange={(e) => setDb((d) => ({ ...d, database: e.target.value }))}
                />
              </Field>

              <div className="jf-grid jf-grid--2">
                <Field label={t("install.database.usernameLabel")}>
                  <input
                    className="jf-input"
                    value={db.username}
                    placeholder="db_user"
                    autoComplete="off"
                    onChange={(e) => setDb((d) => ({ ...d, username: e.target.value }))}
                  />
                </Field>
                <Field label={t("install.database.passwordLabel")}>
                  <input
                    className="jf-input"
                    type="password"
                    value={db.password}
                    autoComplete="new-password"
                    onChange={(e) => setDb((d) => ({ ...d, password: e.target.value }))}
                  />
                </Field>
              </div>

              <Row>
                <button className="jf-btn jf-btn--ghost" onClick={() => setStep("welcome")}>{t("install.back")}</button>
                <button
                  className="jf-btn jf-btn--primary"
                  disabled={!db.host || !db.database || !db.username}
                  onClick={() => setStep("site")}
                >
                  {t("install.next")}
                </button>
              </Row>
            </div>
          )}

          {/* ── SITE ────────────────────────────────────────────────────── */}
          {step === "site" && (
            <div className="jf-stack">
              <h2 className="jf-section-title">{t("install.site.heading")}</h2>
              <Field label={t("install.site.nameLabel")}>
                <input
                  className="jf-input"
                  value={site.name}
                  placeholder={t("ui.installPage.myWebsite")}
                  onChange={(e) => setSite((s) => ({ ...s, name: e.target.value }))}
                />
              </Field>
              <Field label={t("install.site.taglineLabel")}>
                <input
                  className="jf-input"
                  value={site.description}
                  placeholder={t("ui.installPage.justAnotherGreatWebsite")}
                  onChange={(e) => setSite((s) => ({ ...s, description: e.target.value }))}
                />
              </Field>
              <Field label={t("install.site.languageLabel")}>
                <select
                  className="jf-input"
                  value={localeChoice}
                  onChange={(e) => setLocaleChoice(e.target.value)}
                >
                  {INSTALL_LOCALE_CODES.map((code) => (
                    <option key={code} value={code}>
                      {localeOptionLabel(code)}
                    </option>
                  ))}
                  <option value={OTHER_LOCALE}>{t("install.site.otherLanguageOption")}</option>
                </select>
              </Field>
              {localeChoice === OTHER_LOCALE && (
                <Field
                  label={t("install.site.languageCodeLabel")}
                  error={
                    customLocale.trim().length > 0 && !normalizeLocale(customLocale)
                      ? t("install.site.languageCodeError")
                      : undefined
                  }
                >
                  <input
                    className="jf-input"
                    value={customLocale}
                    placeholder="en-US"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={20}
                    onChange={(e) => setCustomLocale(e.target.value)}
                  />
                </Field>
              )}
              <p className="jf-field__hint">
                {t("install.site.languageHint")}
                {customLocalePreview && normalizeLocale(customLocale) ? (
                  <>
                    {" "}
                    {t("install.site.previewPrefix")} {customLocalePreview.name} ·{" "}
                    {customLocalePreview.nativeName}
                  </>
                ) : null}
              </p>
              <p className="jf-field__hint">
                {t("install.site.urlDetectedLabel")} <strong>{siteUrl || "…"}</strong>
              </p>
              <Row>
                <button className="jf-btn jf-btn--ghost" onClick={() => setStep(dbProvisioned ? "welcome" : "database")}>{t("install.back")}</button>
                <button
                  className="jf-btn jf-btn--primary"
                  disabled={!canContinueSite}
                  onClick={() => setStep("account")}
                >
                  {t("install.next")}
                </button>
              </Row>
            </div>
          )}

          {/* ── ACCOUNT ─────────────────────────────────────────────────── */}
          {step === "account" && (
            <div className="jf-stack">
              <h2 className="jf-section-title">{t("install.account.heading")}</h2>
              <p className="jf-prose">{t("install.account.intro")}</p>

              {tokenRequired && (
                <>
                  <Field label={t("install.account.setupKeyLabel")}>
                    <input
                      className="jf-input"
                      value={installTokenValue}
                      placeholder={t("install.account.setupKeyPlaceholder")}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setInstallTokenValue(e.target.value)}
                    />
                  </Field>
                  {installHost ? (
                    <div className="jf-callout">
                      {keyFromHost && installTokenValue.trim() ? (
                        <p className="jf-callout__title">
                          {t("install.account.hostKeyPrefilled", { host: HOST_LABELS[installHost] })}
                        </p>
                      ) : (
                        <>
                          <p className="jf-callout__title">
                            {t("install.account.hostKeyTitle", { host: HOST_LABELS[installHost] })}
                          </p>
                          <p className="jf-prose">{t("install.account.hostKeyBody", { host: HOST_LABELS[installHost] })}</p>
                        </>
                      )}
                      <details>
                        <summary>{t("install.account.hostKeyFallback")}</summary>
                        {setupKeyFileSteps}
                      </details>
                    </div>
                  ) : (
                    <div className="jf-callout">
                      <p className="jf-callout__title">{t("install.account.setupKeyCalloutTitle")}</p>
                      {setupKeyFileSteps}
                    </div>
                  )}
                </>
              )}

              <Field label={t("install.account.emailLabel")}>
                <input
                  className="jf-input"
                  type="email"
                  value={account.email}
                  placeholder="you@example.com"
                  onChange={(e) => setAccount((a) => ({ ...a, email: e.target.value }))}
                />
              </Field>

              <div className="jf-grid jf-grid--2">
                <Field label={t("install.account.usernameLabel")}>
                  <input
                    className="jf-input"
                    value={account.username}
                    placeholder="admin"
                    onChange={(e) => setAccount((a) => ({ ...a, username: e.target.value }))}
                  />
                </Field>
                <Field label={t("install.account.displayNameLabel")}>
                  <input
                    className="jf-input"
                    value={account.displayName}
                    placeholder={t("ui.installPage.siteAdmin")}
                    onChange={(e) => setAccount((a) => ({ ...a, displayName: e.target.value }))}
                  />
                </Field>
              </div>

              <div className="jf-grid jf-grid--2">
                <Field
                  label={t("install.account.passwordLabel")}
                  error={account.password.length > 0 && account.password.length < 12 ? t("install.account.passwordTooShort") : undefined}
                >
                  <input
                    className={`jf-input${account.password.length > 0 && account.password.length < 12 ? " jf-input--invalid" : ""}`}
                    type="password"
                    value={account.password}
                    autoComplete="new-password"
                    onChange={(e) => setAccount((a) => ({ ...a, password: e.target.value }))}
                  />
                </Field>
                <Field label={t("install.account.confirmPasswordLabel")} error={!passwordsMatch ? t("install.account.passwordsMismatch") : undefined}>
                  <input
                    className={`jf-input${!passwordsMatch ? " jf-input--invalid" : ""}`}
                    type="password"
                    value={account.confirmPassword}
                    autoComplete="new-password"
                    onChange={(e) =>
                      setAccount((a) => ({ ...a, confirmPassword: e.target.value }))
                    }
                  />
                </Field>
              </div>

              <label className="jf-checkrow jf-checkrow--stacked" htmlFor="jf-install-email-details">
                <input
                  id="jf-install-email-details"
                  type="checkbox"
                  checked={account.emailDetails}
                  onChange={(e) => setAccount((a) => ({ ...a, emailDetails: e.target.checked }))}
                />
                <span>
                  {t("install.account.emailDetailsLabel")}
                  <span className="jf-checkrow__meta">{t("install.account.emailDetailsMeta")}</span>
                </span>
              </label>

              <Row>
                <button className="jf-btn jf-btn--ghost" onClick={() => setStep("site")}>{t("install.back")}</button>
                <button
                  className="jf-btn jf-btn--primary"
                  disabled={!canInstall}
                  onClick={runInstall}
                >
                  {t("install.account.installCta")}
                </button>
              </Row>
            </div>
          )}

          {/* ── INSTALLING ──────────────────────────────────────────────── */}
          {step === "installing" && (
            <div className="jf-stack">
              <h2 className="jf-section-title">
                {fatalError ? t("install.installing.failedHeading") : t("install.installing.heading")}
              </h2>
              <div className="jf-log" role="log" aria-live="polite" aria-relevant="additions">
                {log.map((entry, i) => (
                  <p
                    key={i}
                    className={`jf-log__line${
                      entry.status === "ok" ? " jf-log__line--ok"
                        : entry.status === "error" ? " jf-log__line--fail"
                        : ""
                    }`}
                  >
                    {entry.status === "ok" ? "✓" : entry.status === "error" ? "✗" : "⋯"} {entry.message}
                  </p>
                ))}
              </div>

              {fatalError && (
                <div className="jf-alert jf-alert--error" role="alert">
                  <strong>{t("install.installing.errorLabel")}</strong> {fatalError}
                </div>
              )}

              {fatalError && (
                <button className="jf-btn jf-btn--ghost" onClick={switchToOwnDatabase}>
                  {t("install.installing.fixSettings")}
                </button>
              )}
            </div>
          )}

          {/* ── DONE ────────────────────────────────────────────────────── */}
          {step === "done" && (
            <div className="jf-stack" style={{ textAlign: "center", alignItems: "center" }}>
              <div style={{ fontSize: "3.5rem", marginBottom: "0.75rem" }}>🎉</div>
              <h2 className="jf-section-title">
                {t("install.done.heading", { name: site.name || t("install.done.defaultSiteName") })}
              </h2>
              <p className="jf-prose" style={{ marginInline: "auto" }}>
                {t("install.done.signInPrefix")} <strong>{account.email}</strong>{" "}
                {t("install.done.signInSuffix")}
              </p>
              <button
                className="jf-btn jf-btn--primary"
                onClick={() => navigate("/admin")}
              >
                {t("install.done.dashboardCta")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── small components ──────────────────────────────────────────────────────────

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactElement<{ id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string }>;
}) {
  const htmlFor = `jf-install-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: htmlFor,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": errorId,
      })
    : children;

  return (
    <div className="jf-field">
      <label className="jf-field__label" htmlFor={htmlFor}>{label}</label>
      {control}
      {error && (
        <p id={errorId} className="jf-field__hint" role="alert" style={{ color: "var(--jf-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="jf-navrow">{children}</div>;
}
