import StorageUsageCard, { type StorageUsage } from "../../../components/StorageUsageCard";
import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Link, useNavigate } from "../../../admin-router";
import { useT } from "../../../i18n/I18nProvider";
import { initialJson } from "../../../ssr-data";
import QuotaLimitsCard, { type QuotaMeter } from "./QuotaLimitsCard";

interface PlatformSite {
  storage?: StorageUsage;
  site: {
    id: string;
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    tenantStatus: string;
    userMode: string;
    databaseMode: string;
    name: string;
    url: string;
    description: string;
    active: boolean;
    status: string;
    databaseChoice: string;
    installedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  domains: Array<{
    id: string;
    hostname: string;
    kind: string;
    verified: boolean;
    isPrimary: boolean;
  }>;
  database: {
    id: string;
    siteId: string | null;
    mode: string;
    status: string;
    driver: string | null;
    host: string;
    port: number | null;
    databaseName: string;
    username: string;
    passwordSet: boolean;
    lastError: string | null;
    scope: "site" | "workspace";
    editable: boolean;
  } | null;
  quotas?: { meters: QuotaMeter[] };
}

interface DomainDraft {
  key: string;
  id: string | null;
  hostname: string;
  kind: "primary" | "subdomain" | "custom";
  verified: boolean;
  isPrimary: boolean;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** The saved site address as an http(s) link, or "" when it is not one. */
function safeHttpUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function asKind(value: string): DomainDraft["kind"] {
  if (value === "subdomain" || value === "custom") return value;
  return "primary";
}

function draftsFrom(site: PlatformSite): DomainDraft[] {
  const domains = site.domains.map((domain) => ({
    key: domain.id,
    id: domain.id,
    hostname: domain.hostname,
    kind: asKind(domain.kind),
    verified: domain.verified,
    isPrimary: domain.isPrimary,
  }));
  if (domains.length > 0 && !domains.some((domain) => domain.isPrimary)) domains[0]!.isPrimary = true;
  return domains;
}

export default function PlatformSitePage() {
  const { id } = useParams();
  const { t } = useT();
  const navigate = useNavigate();
  const requestUrl = `/api/platform/sites/${encodeURIComponent(id ?? "")}`;
  const seeded = initialJson<PlatformSite>(requestUrl);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>();
  const [record, setRecord] = useState<PlatformSite | null>(seeded ?? null);
  const [name, setName] = useState(seeded?.site.name ?? "");
  const [description, setDescription] = useState(seeded?.site.description ?? "");
  const [url, setUrl] = useState(seeded?.site.url ?? "");
  const [status, setStatus] = useState(seeded?.site.status === "suspended" ? "suspended" : "active");
  const [databaseChoice, setDatabaseChoice] = useState(seeded?.site.databaseChoice ?? "inherit");
  const [domains, setDomains] = useState<DomainDraft[]>(seeded ? draftsFrom(seeded) : []);
  const [host, setHost] = useState(seeded?.database?.host ?? "");
  const [port, setPort] = useState(seeded?.database?.port ? String(seeded.database.port) : "");
  const [databaseName, setDatabaseName] = useState(seeded?.database?.databaseName ?? "");
  const [username, setUsername] = useState(seeded?.database?.username ?? "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(!seeded);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function apply(site: PlatformSite) {
    setRecord(site);
    setName(site.site.name);
    setDescription(site.site.description);
    setUrl(site.site.url);
    setStatus(site.site.status === "suspended" ? "suspended" : "active");
    setDatabaseChoice(site.site.databaseChoice);
    setDomains(draftsFrom(site));
    setHost(site.database?.host ?? "");
    setPort(site.database?.port ? String(site.database.port) : "");
    setDatabaseName(site.database?.databaseName ?? "");
    setUsername(site.database?.username ?? "");
    setPassword("");
  }

  useEffect(() => {
    if (seeded) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void fetch(requestUrl)
      .then(async (res) => {
        const body = await res.json() as PlatformSite & { error?: string };
        if (res.status === 403) throw new Error(t("platform.forbidden"));
        if (res.status === 404) throw new Error(t("platform.siteNotFound"));
        if (!res.ok || !body.site) throw new Error(body.error ?? t("platform.siteLoadFailed"));
        if (!cancelled) apply(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("platform.siteLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestUrl, seeded, t]);

  function updateDomain(key: string, patch: Partial<DomainDraft>) {
    setDomains((current) => current.map((domain) => (domain.key === key ? { ...domain, ...patch } : domain)));
  }

  function makePrimary(key: string) {
    setDomains((current) => current.map((domain) => ({ ...domain, isPrimary: domain.key === key })));
  }

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record) return;
    setSaving(true);
    setError("");
    setNotice("");
    const editable = record.database?.editable === true;
    const res = await fetch(requestUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        url,
        status,
        databaseChoice,
        domains: domains.map((domain) => ({
          id: domain.id,
          hostname: domain.hostname,
          kind: domain.kind,
          verified: domain.verified,
          isPrimary: domain.isPrimary,
        })),
        database: editable
          ? { host, port: Number(port), database: databaseName, username, password }
          : null,
      }),
    });
    const body = await res.json() as PlatformSite & { error?: string };
    setSaving(false);
    if (!res.ok || !body.site) {
      setError(body.error ?? t("platform.siteSaveFailed"));
      return;
    }
    apply(body);
    setNotice(t("platform.saved"));
  }

  const locked = record != null && record.site.status !== "active" && record.site.status !== "suspended";
  const openUrl = safeHttpUrl(record?.site.url);
  const goBack = () => navigate("/admin/platform/sites");

  if (!record) {
    return (
      <>
        <header className="jf-topbar">
          <button type="button" className="jf-btn jf-btn--quiet" onClick={goBack}>← {t("common.back")}</button>
        </header>
        <div className="jf-page">
          {loading ? <p>{t("platform.loading")}</p> : (
            <div className="jf-alert jf-alert--error" role="alert">{error || t("platform.siteNotFound")}</div>
          )}
        </div>
      </>
    );
  }

  const dbLocked = locked || !record.database?.editable;

  return (
    <>
      <header className="jf-topbar">
        <button type="button" className="jf-btn jf-btn--quiet" onClick={goBack}>← {t("common.back")}</button>
        <div className="jf-topbar__title">
          <span className="jf-topbar__eyebrow">{t("platform.sitePage")} · {record.site.tenantName}</span>
          <h1>{record.site.name || t("platform.sitePage")}</h1>
        </div>
        <div className="jf-topbar__actions">
          {openUrl ? (
            <a className="jf-btn jf-btn--ghost" href={openUrl} target="_blank" rel="noopener noreferrer">{t("platform.openSite")}</a>
          ) : null}
          <button className="jf-btn jf-btn--primary" form="jf-platform-site-form" type="submit" disabled={saving || locked}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </header>

      <div className="jf-page">
        {error ? <div className="jf-alert jf-alert--error" role="alert">{error}</div> : null}
        {notice ? <div className="jf-alert jf-alert--success" role="status">{notice}</div> : null}

        <form id="jf-platform-site-form" className="jf-split" onSubmit={(event) => void onSave(event)}>
          <div className="jf-stack jf-stack--lg">
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.sitePage")}</h2>
              </div>
              <div className="jf-card__body jf-stack">
                <p className="jf-field__hint">{t("platform.siteIntro")}</p>
                <div className="jf-grid jf-grid--2">
                  <Field label={t("platform.siteName")}>
                    <input className="jf-input" value={name} onChange={(event) => setName(event.target.value)} required disabled={locked} />
                  </Field>
                  <Field label={t("platform.url")}>
                    <input className="jf-input jf-input--mono" value={url} onChange={(event) => setUrl(event.target.value)} required disabled={locked} />
                  </Field>
                </div>
                <Field label={t("platform.description")}>
                  <textarea className="jf-input" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} disabled={locked} />
                </Field>
              </div>
            </section>

            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.domains")}</h2>
                <button
                  type="button"
                  className="jf-btn jf-btn--sm"
                  style={{ marginLeft: "auto" }}
                  disabled={locked}
                  onClick={() => setDomains((current) => [
                    ...current,
                    { key: `new-${current.length}-${Date.now()}`, id: null, hostname: "", kind: "custom", verified: false, isPrimary: current.length === 0 },
                  ])}
                >
                  {t("platform.addDomain")}
                </button>
              </div>
              <div className="jf-card__body--flush jf-tablewrap">
                <table className="jf-table">
                  <thead>
                    <tr>
                      <th>{t("platform.hostname")}</th>
                      <th>{t("platform.kind")}</th>
                      <th>{t("platform.primary")}</th>
                      <th>{t("platform.verified")}</th>
                      <th><span className="jf-sr-only">{t("common.actions")}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {domains.map((domain) => (
                      <tr key={domain.key}>
                        <td>
                          <input
                            className="jf-input jf-input--mono"
                            aria-label={t("platform.hostname")}
                            value={domain.hostname}
                            onChange={(event) => updateDomain(domain.key, { hostname: event.target.value })}
                            required
                            disabled={locked}
                          />
                        </td>
                        <td>
                          <select
                            className="jf-input"
                            aria-label={t("platform.kind")}
                            value={domain.kind}
                            onChange={(event) => updateDomain(domain.key, { kind: asKind(event.target.value) })}
                            disabled={locked}
                          >
                            <option value="primary">{t("platform.kindPrimary")}</option>
                            <option value="subdomain">{t("platform.kindSubdomain")}</option>
                            <option value="custom">{t("platform.kindCustom")}</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="radio"
                            name="primaryDomain"
                            aria-label={`${t("platform.primary")}: ${domain.hostname}`}
                            checked={domain.isPrimary}
                            onChange={() => makePrimary(domain.key)}
                            disabled={locked}
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${t("platform.verified")}: ${domain.hostname}`}
                            checked={domain.verified}
                            onChange={(event) => updateDomain(domain.key, { verified: event.target.checked })}
                            disabled={locked}
                          />
                        </td>
                        <td className="jf-td--actions">
                          <button
                            type="button"
                            className="jf-btn jf-btn--quiet jf-btn--sm"
                            disabled={locked || domains.length === 1}
                            onClick={() => setDomains((current) => {
                              const next = current.filter((item) => item.key !== domain.key);
                              if (next.length > 0 && !next.some((item) => item.isPrimary)) next[0]!.isPrimary = true;
                              return next;
                            })}
                          >
                            {t("platform.removeDomain")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="jf-card__body">
                <p className="jf-field__hint">{t("platform.domainHint")}</p>
              </div>
            </section>

            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.database")}</h2>
                {record.database ? <span className={`jf-badge${statusBadge(record.database.status)}`}>{record.database.status}</span> : null}
              </div>
              <div className="jf-card__body jf-stack">
                <Field label={t("platform.databaseChoice")}>
                  <select className="jf-input" value={databaseChoice} onChange={(event) => setDatabaseChoice(event.target.value)} disabled={locked}>
                    <option value="inherit">{t("platform.inherit")}</option>
                    <option value="current">{t("platform.current")}</option>
                    <option value="separate">{t("platform.separate")}</option>
                  </select>
                </Field>
                {record.database?.scope === "workspace" ? <p className="jf-field__hint">{t("platform.databaseWorkspace")}</p> : null}
                {record.database?.lastError ? (
                  <div className="jf-alert jf-alert--error" role="alert">{t("platform.lastError")}: {record.database.lastError}</div>
                ) : null}
                {record.database ? (
                  <div className="jf-grid jf-grid--2">
                    <Field label={t("platform.host")}>
                      <input className="jf-input jf-input--mono" value={host} onChange={(event) => setHost(event.target.value)} disabled={dbLocked} />
                    </Field>
                    <Field label={t("platform.port")}>
                      <input className="jf-input jf-input--mono" value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" disabled={dbLocked} />
                    </Field>
                    <Field label={t("platform.databaseName")}>
                      <input className="jf-input jf-input--mono" value={databaseName} onChange={(event) => setDatabaseName(event.target.value)} disabled={dbLocked} />
                    </Field>
                    <Field label={t("platform.username")}>
                      <input className="jf-input jf-input--mono" value={username} onChange={(event) => setUsername(event.target.value)} disabled={dbLocked} />
                    </Field>
                    {record.database.editable ? (
                      <Field label={t("platform.password")}>
                        <input
                          className="jf-input"
                          type="password"
                          value={password}
                          autoComplete="new-password"
                          placeholder={record.database.passwordSet ? t("platform.passwordKeep") : ""}
                          onChange={(event) => setPassword(event.target.value)}
                          disabled={locked}
                        />
                      </Field>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <aside className="jf-rail">
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.status")}</h2>
                <span className={`jf-badge${statusBadge(record.site.status)}`}>{statusLabel(record.site.status, t)}</span>
              </div>
              <div className="jf-card__body jf-stack">
                {locked ? null : (
                  <Field label={t("platform.status")}>
                    <select className="jf-input" value={status} onChange={(event) => setStatus(event.target.value)}>
                      <option value="active">{t("platform.statusActive")}</option>
                      <option value="suspended">{t("platform.statusSuspended")}</option>
                    </select>
                  </Field>
                )}
                <button className="jf-btn jf-btn--primary jf-btn--block" type="submit" disabled={saving || locked}>
                  {saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </section>

            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.siteUsers")}</h2>
              </div>
              <div className="jf-card__body jf-stack">
                <p className="jf-field__hint">{t("platform.siteUsersIntro")}</p>
                <Link className="jf-btn jf-btn--block" to={`/admin/platform/sites/${record.site.id}/users`}>{t("platform.manageUsers")}</Link>
              </div>
            </section>

            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.record")}</h2>
              </div>
              <div className="jf-card__body">
                <dl>
                  <MetaRow label={t("platform.siteId")} value={<code>{record.site.id}</code>} />
                  <MetaRow label={t("platform.workspace")} value={`${record.site.tenantName} · ${record.site.tenantSlug}`} />
                  <MetaRow
                    label={t("platform.workspaceStatus")}
                    value={<span className={`jf-badge${statusBadge(record.site.tenantStatus)}`}>{statusLabel(record.site.tenantStatus, t)}</span>}
                  />
                  <MetaRow label={t("platform.userMode")} value={record.site.userMode === "shared" ? t("platform.shared") : t("platform.isolated")} />
                  <MetaRow label={t("platform.database")} value={record.site.databaseMode === "separate" ? t("platform.separate") : t("platform.current")} />
                  {record.database?.driver ? <MetaRow label={t("platform.driver")} value={record.database.driver} /> : null}
                  <MetaRow label={t("platform.installed")} value={formatDate(record.site.installedAt)} />
                  <MetaRow label={t("platform.created")} value={formatDate(record.site.createdAt)} />
                  <MetaRow label={t("platform.updated")} value={formatDate(record.site.updatedAt)} />
                </dl>
              </div>
            </section>
          </aside>
        </form>
        <StorageUsageCard usage={record.storage} onMeasured={setStorageUsage} endpoint={`/api/platform/sites/${encodeURIComponent(id ?? "")}/storage`} />
        <QuotaLimitsCard
          key={id}
          endpoint={`/api/platform/sites/${encodeURIComponent(id ?? "")}/quotas`}
          meters={record.quotas?.meters ?? []}
          storageUsageBytes={storageUsage === undefined ? undefined : storageUsage?.totalBytes ?? null}
        />
      </div>
    </>
  );
}

function statusBadge(status: string): string {
  if (status === "active" || status === "ready" || status === "connected") return " jf-badge--ok";
  if (status === "suspended" || status === "pending" || status === "provisioning") return " jf-badge--warn";
  if (status === "deleted" || status === "error" || status === "failed") return " jf-badge--error";
  return "";
}

function statusLabel(status: string, t: (key: string) => string): string {
  if (status === "active") return t("platform.statusActive");
  if (status === "suspended") return t("platform.statusSuspended");
  return status;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="jf-field">
      <span className="jf-field__label">{label}</span>
      {children}
    </label>
  );
}

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="jf-meta__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
