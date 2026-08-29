import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../../i18n/I18nProvider";

export type PluginSetupField = {
  name: string;
  label: string;
  type: "text" | "password" | "email" | "number" | "checkbox" | "select" | "textarea";
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  disabled?: boolean;
  hint?: string;
};

export type PluginSetupView = {
  kind: "setup";
  complete: boolean;
  title: string;
  description: string;
  step: number;
  steps: Array<{ id: string; label: string }>;
  fields: PluginSetupField[];
  values: Record<string, string | number | boolean>;
  probe?: {
    ok: boolean;
    error?: string;
    dialect?: string;
    serverVersion?: string;
    tls: boolean;
    latencyMs: number;
  };
  envManaged: boolean;
  passwordConfigured: boolean;
  readOnly: boolean;
  message?: string;
  canContinue: boolean;
  canFinish: boolean;
};

async function readSetupResponse(res: Response): Promise<PluginSetupView | null> {
  if (!res.ok) return null;
  const ctype = typeof res.headers?.get === "function" ? res.headers.get("content-type") ?? "" : "";
  if (ctype && !ctype.includes("json")) return null;
  try {
    const data = (await res.json()) as PluginSetupView;
    if (data && data.kind === "setup" && Array.isArray(data.steps)) return data;
  } catch {
    return null;
  }
  return null;
}

function fieldValue(
  values: Record<string, string | number | boolean>,
  name: string,
  type: PluginSetupField["type"],
): string | number | boolean {
  const current = values[name];
  if (type === "checkbox") return current === true;
  if (typeof current === "string" || typeof current === "number") return current;
  return "";
}

export default function PluginSetupWizard({
  pluginId,
  fallback,
  completeExtra,
}: {
  pluginId: string;
  fallback: ReactNode;
  /** Shown after first-run setup is done. Settings stay on `/admin/plugins/{id}/settings`. */
  completeExtra?: ReactNode;
}) {
  const { t } = useT();
  const [view, setView] = useState<PluginSetupView | null>(null);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/ext/${encodeURIComponent(pluginId)}/setup`)
      .then((res) => readSetupResponse(res))
      .then((next) => {
        if (cancelled) return;
        if (!next) {
          setMissing(true);
          setView(null);
          return;
        }
        setMissing(false);
        setView(next);
        setValues(next.values);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  async function submit(action: "next" | "back" | "probe" | "complete" | "save") {
    setBusy(true);
    try {
      const res = await fetch(`/ext/${encodeURIComponent(pluginId)}/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, values }),
      });
      const next = await readSetupResponse(res);
      if (next) {
        setView(next);
        setValues(next.values);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="jf-skeleton" style={{ height: 240 }} />;
  }

  if (missing || !view) return fallback;

  if (view.complete) {
    return completeExtra ?? fallback;
  }

  const probe = view.probe;
  const last = view.step >= view.steps.length - 1;

  return (
    <div className="jf-stack">
      <div className="jf-card">
        <div className="jf-card__body jf-stack">
          <ol className="jf-setup-steps" aria-label={t("pluginSetup.steps")}>
            {view.steps.map((step, index) => (
              <li
                key={step.id}
                className="jf-setup-steps__item"
                data-current={index === view.step ? "true" : "false"}
                data-done={index < view.step ? "true" : "false"}
              >
                {step.label}
              </li>
            ))}
          </ol>

        <div>
          <h2 className="jf-card__title">{view.title}</h2>
          <p className="jf-meta">{view.description}</p>
        </div>

        {view.message && (
          <div className="jf-alert jf-alert--info" role="status">
            {view.message}
          </div>
        )}

        {view.envManaged && (
          <div className="jf-alert jf-alert--info" role="status">
            {t("pluginSetup.envManaged")}
          </div>
        )}

        {view.readOnly && (
          <div className="jf-alert jf-alert--info" role="status">
            {t("pluginSetup.readOnly")}
          </div>
        )}

        {probe && (
          <div
            className={`jf-alert ${probe.ok ? "jf-alert--success" : "jf-alert--error"}`}
            role={probe.ok ? "status" : "alert"}
          >
            {probe.ok
              ? t("pluginSetup.probeOk", {
                  latency: probe.latencyMs,
                  detail: probe.serverVersion ? ` · ${probe.serverVersion}` : "",
                })
              : `${t("pluginSetup.probeFail")}${probe.error ? `: ${probe.error}` : ""}`}
          </div>
        )}

        {view.fields.length > 0 && (
          <div className="jf-stack">
            {view.fields.map((field) => {
              const id = `jf-setup-${field.name}`;
              const disabled = busy || view.readOnly || field.disabled;
              if (field.type === "checkbox") {
                return (
                  <div key={field.name}>
                    <label className="jf-checkrow">
                      <input
                        id={id}
                        type="checkbox"
                        checked={fieldValue(values, field.name, field.type) === true}
                        disabled={disabled}
                        onChange={(event) =>
                          setValues((prev) => ({ ...prev, [field.name]: event.target.checked }))
                        }
                      />
                      <span>{field.label}</span>
                    </label>
                    {field.hint && <p className="jf-field__hint">{field.hint}</p>}
                  </div>
                );
              }
              if (field.type === "select") {
                return (
                  <div className="jf-field" key={field.name}>
                    <label className="jf-field__label" htmlFor={id}>
                      {field.label}
                    </label>
                    <select
                      id={id}
                      className="jf-input"
                      required={field.required}
                      disabled={disabled}
                      value={String(fieldValue(values, field.name, field.type))}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                      }
                    >
                      {(field.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {field.hint && <p className="jf-field__hint">{field.hint}</p>}
                  </div>
                );
              }
              if (field.type === "textarea") {
                return (
                  <div className="jf-field" key={field.name}>
                    <label className="jf-field__label" htmlFor={id}>
                      {field.label}
                    </label>
                    <textarea
                      id={id}
                      className="jf-input"
                      required={field.required}
                      disabled={disabled}
                      value={String(fieldValue(values, field.name, field.type))}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
                      }
                    />
                    {field.hint && <p className="jf-field__hint">{field.hint}</p>}
                  </div>
                );
              }
              return (
                <div className="jf-field" key={field.name}>
                  <label className="jf-field__label" htmlFor={id}>
                    {field.label}
                  </label>
                  <input
                    id={id}
                    className="jf-input"
                    type={field.type}
                    autoComplete={field.type === "password" ? "new-password" : "off"}
                    required={field.required}
                    disabled={disabled}
                    value={String(fieldValue(values, field.name, field.type))}
                    onChange={(event) =>
                      setValues((prev) => ({
                        ...prev,
                        [field.name]:
                          field.type === "number" ? Number(event.target.value) : event.target.value,
                      }))
                    }
                  />
                  {field.hint && <p className="jf-field__hint">{field.hint}</p>}
                </div>
              );
            })}
          </div>
        )}

        {!view.readOnly && (
          <div className="jf-navrow">
            <button
              type="button"
              className="jf-btn jf-btn--ghost"
              disabled={busy || view.step === 0}
              onClick={() => void submit("back")}
            >
              {t("pluginSetup.back")}
            </button>
            <div className="jf-row" style={{ gap: "0.5rem" }}>
              {view.steps[view.step]?.id === "probe" && (
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost"
                  disabled={busy}
                  onClick={() => void submit("probe")}
                >
                  {busy ? t("pluginSetup.testing") : t("pluginSetup.test")}
                </button>
              )}
              {last ? (
                <button
                  type="button"
                  className="jf-btn"
                  disabled={busy}
                  onClick={() => void submit("complete")}
                >
                  {busy ? t("pluginSetup.saving") : t("pluginSetup.finish")}
                </button>
              ) : (
                <button
                  type="button"
                  className="jf-btn"
                  disabled={busy || !view.canContinue}
                  onClick={() => void submit("next")}
                >
                  {t("pluginSetup.next")}
                </button>
              )}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
