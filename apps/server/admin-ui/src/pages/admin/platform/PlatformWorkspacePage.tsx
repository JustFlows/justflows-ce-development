import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { Link, useNavigate } from "../../../admin-router";
import { useT } from "../../../i18n/I18nProvider";
import { initialJson } from "../../../ssr-data";
import QuotaLimitsCard, { type QuotaMeter } from "./QuotaLimitsCard";

interface PlatformWorkspace {
  workspace: {
    id: string;
    name: string;
    slug: string;
    status: string;
    userMode: string;
    databaseMode: string;
    createdAt: string;
    updatedAt: string;
    owner?: { id: string; name: string; email: string } | null;
  };
  sites: Array<{
    id: string;
    name: string;
    url: string;
    hostname: string | null;
    status: string;
    databaseChoice: string;
  }>;
  database: {
    id: string;
    status: string;
    driver: string | null;
    host: string;
    port: number | null;
    databaseName: string;
    username: string;
    lastError: string | null;
  } | null;
  quotas?: { meters: QuotaMeter[] };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function PlatformWorkspacePage() {
  const { id } = useParams();
  const { t } = useT();
  const navigate = useNavigate();
  const requestUrl = `/api/platform/tenants/${encodeURIComponent(id ?? "")}`;
  const seeded = initialJson<PlatformWorkspace>(requestUrl);
  const [record, setRecord] = useState<PlatformWorkspace | null>(seeded ?? null);
  const [name, setName] = useState(seeded?.workspace.name ?? "");
  const [slug, setSlug] = useState(seeded?.workspace.slug ?? "");
  const [loading, setLoading] = useState(!seeded);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function apply(workspace: PlatformWorkspace) {
    setRecord(workspace);
    setName(workspace.workspace.name);
    setSlug(workspace.workspace.slug);
  }

  async function reload(): Promise<void> {
    const res = await fetch(requestUrl);
    const body = await res.json() as PlatformWorkspace & { error?: string };
    if (res.status === 403) throw new Error(t("platform.forbidden"));
    if (res.status === 404) throw new Error(t("platform.workspaceNotFound"));
    if (!res.ok || !body.workspace) throw new Error(body.error ?? t("platform.workspaceLoadFailed"));
    apply(body);
  }

  useEffect(() => {
    if (seeded) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void fetch(requestUrl)
      .then(async (res) => {
        const body = await res.json() as PlatformWorkspace & { error?: string };
        if (res.status === 403) throw new Error(t("platform.forbidden"));
        if (res.status === 404) throw new Error(t("platform.workspaceNotFound"));
        if (!res.ok || !body.workspace) throw new Error(body.error ?? t("platform.workspaceLoadFailed"));
        if (!cancelled) apply(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t("platform.workspaceLoadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestUrl, seeded, t]);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record) return;
    setSaving(true);
    setError("");
    setNotice("");
    const res = await fetch(requestUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug }),
    });
    const body = await res.json() as PlatformWorkspace & { error?: string };
    setSaving(false);
    if (!res.ok || !body.workspace) {
      setError(body.error ?? t("platform.workspaceSaveFailed"));
      return;
    }
    apply(body);
    setNotice(t("platform.saved"));
  }

  async function act(action: "suspend" | "reactivate") {
    if (!record) return;
    setError("");
    setNotice("");
    const res = await fetch(`/api/platform/tenants/${encodeURIComponent(record.workspace.id)}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setError(body.error ?? t("platform.workspaceSaveFailed"));
      return;
    }
    try {
      await reload();
      setNotice(t("platform.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("platform.workspaceLoadFailed"));
    }
  }

  const goBack = () => navigate("/admin/platform/workspaces");

  if (!record) {
    return (
      <>
        <header className="jf-topbar">
          <button type="button" className="jf-btn jf-btn--quiet" onClick={goBack}>← {t("common.back")}</button>
        </header>
        <div className="jf-page">
          {loading ? <p>{t("platform.workspaceLoading")}</p> : (
            <div className="jf-alert jf-alert--error" role="alert">{error || t("platform.workspaceNotFound")}</div>
          )}
        </div>
      </>
    );
  }

  const status = record.workspace.status;
  const locked = status !== "active" && status !== "suspended";
  const primary = record.workspace.slug === "primary";

  return (
    <>
      <header className="jf-topbar">
        <button type="button" className="jf-btn jf-btn--quiet" onClick={goBack}>← {t("common.back")}</button>
        <div className="jf-topbar__title">
          <span className="jf-topbar__eyebrow">{t("platform.workspace")}</span>
          <h1>{record.workspace.name || t("platform.workspace")}</h1>
        </div>
        <div className="jf-topbar__actions">
          <button className="jf-btn jf-btn--primary" form="jf-platform-workspace-form" type="submit" disabled={saving || locked}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </header>

      <div className="jf-page">
        {error ? <div className="jf-alert jf-alert--error" role="alert">{error}</div> : null}
        {notice ? <div className="jf-alert jf-alert--success" role="status">{notice}</div> : null}

        <form id="jf-platform-workspace-form" className="jf-split" onSubmit={(event) => void onSave(event)}>
          <div className="jf-stack jf-stack--lg">
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.workspace")}</h2>
              </div>
              <div className="jf-card__body jf-stack">
                <p className="jf-field__hint">{t("platform.workspaceIntro")}</p>
                <div className="jf-grid jf-grid--2">
                  <Field label={t("platform.name")}>
                    <input className="jf-input" value={name} onChange={(event) => setName(event.target.value)} required maxLength={255} disabled={locked} />
                  </Field>
                  <Field label={t("platform.slug")}>
                    <input
                      className="jf-input jf-input--mono"
                      value={slug}
                      onChange={(event) => setSlug(event.target.value)}
                      required
                      maxLength={60}
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      disabled={locked || primary}
                    />
                  </Field>
                </div>
                <p className="jf-field__hint">{primary ? t("platform.slugPrimary") : t("platform.slugHint")}</p>
              </div>
            </section>

            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.sites")}</h2>
              </div>
              {record.sites.length === 0 ? (
                <div className="jf-card__body"><p className="jf-field__hint">—</p></div>
              ) : (
                <div className="jf-card__body--flush jf-tablewrap">
                  <table className="jf-table">
                    <thead>
                      <tr>
                        <th>{t("platform.siteName")}</th>
                        <th>{t("platform.hostname")}</th>
                        <th>{t("platform.status")}</th>
                        <th>{t("platform.database")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {record.sites.map((site) => (
                        <tr key={site.id}>
                          <td className="jf-td--strong">
                            <Link to={`/admin/platform/sites/${site.id}`}>{site.name}</Link>
                          </td>
                          <td><code>{site.hostname ?? "—"}</code></td>
                          <td><span className={`jf-badge${statusBadge(site.status)}`}>{statusLabel(site.status, t)}</span></td>
                          <td>
                            {site.databaseChoice === "separate" ? t("platform.separate") : site.databaseChoice === "current" ? t("platform.current") : t("platform.inherit")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {record.database ? (
              <section className="jf-card">
                <div className="jf-card__head">
                  <h2 className="jf-card__title">{t("platform.database")}</h2>
                  <span className={`jf-badge${statusBadge(record.database.status)}`}>{record.database.status}</span>
                </div>
                <div className="jf-card__body jf-stack">
                  {record.database.lastError ? (
                    <div className="jf-alert jf-alert--error" role="alert">{t("platform.lastError")}: {record.database.lastError}</div>
                  ) : null}
                  <dl>
                    {record.database.driver ? <MetaRow label={t("platform.driver")} value={record.database.driver} /> : null}
                    <MetaRow label={t("platform.host")} value={<code>{record.database.host || "—"}</code>} />
                    <MetaRow label={t("platform.port")} value={<code>{record.database.port ?? "—"}</code>} />
                    <MetaRow label={t("platform.databaseName")} value={<code>{record.database.databaseName || "—"}</code>} />
                    <MetaRow label={t("platform.username")} value={<code>{record.database.username || "—"}</code>} />
                  </dl>
                </div>
              </section>
            ) : null}
          </div>

          <aside className="jf-rail">
            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.status")}</h2>
                <span className={`jf-badge${statusBadge(status)}`}>{statusLabel(status, t)}</span>
              </div>
              <div className="jf-card__body jf-stack">
                {status === "suspended" ? (
                  <button type="button" className="jf-btn jf-btn--block" onClick={() => void act("reactivate")}>{t("platform.reactivate")}</button>
                ) : status === "active" ? (
                  <button type="button" className="jf-btn jf-btn--danger jf-btn--block" onClick={() => void act("suspend")}>{t("platform.suspend")}</button>
                ) : null}
                <button className="jf-btn jf-btn--primary jf-btn--block" type="submit" disabled={saving || locked}>
                  {saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </section>

            <section className="jf-card">
              <div className="jf-card__head">
                <h2 className="jf-card__title">{t("platform.record")}</h2>
              </div>
              <div className="jf-card__body">
                <dl>
                  <MetaRow label={t("platform.workspaceId")} value={<code>{record.workspace.id}</code>} />
                  <MetaRow label={t("platform.workspaceOwner")} value={record.workspace.owner ? (
                    <div className="jf-stack">
                      <Link to={`/admin/users/${encodeURIComponent(record.workspace.owner.id)}`}>
                        {record.workspace.owner.name}
                      </Link>
                      <span>{record.workspace.owner.email}</span>
                      <Link to={`/admin/users/${encodeURIComponent(record.workspace.owner.id)}`}>
                        <code style={{ overflowWrap: "anywhere" }}>{record.workspace.owner.id}</code>
                      </Link>
                    </div>
                  ) : "—"} />
                  <MetaRow label={t("platform.userMode")} value={record.workspace.userMode === "shared" ? t("platform.shared") : t("platform.isolated")} />
                  <MetaRow label={t("platform.database")} value={record.workspace.databaseMode === "separate" ? t("platform.separate") : t("platform.current")} />
                  <MetaRow label={t("platform.created")} value={formatDate(record.workspace.createdAt)} />
                  <MetaRow label={t("platform.updated")} value={formatDate(record.workspace.updatedAt)} />
                </dl>
              </div>
            </section>
          </aside>
        </form>
        <QuotaLimitsCard
          key={id}
          endpoint={`/api/platform/tenants/${encodeURIComponent(id ?? "")}/quotas`}
          meters={record.quotas?.meters ?? []}
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
