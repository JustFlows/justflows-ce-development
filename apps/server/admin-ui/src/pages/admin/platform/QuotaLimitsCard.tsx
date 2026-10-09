import { formatStorageBytes } from "../../../components/StorageUsageCard";
import { FormEvent, useId, useState } from "react";
import { useT } from "../../../i18n/I18nProvider";

export interface QuotaMeter {
  key: string;
  scope: "workspace" | "site";
  label: string;
  unit: "count" | "bytes" | "flag";
  limit: number | null;
  used: number | null;
}

const STORAGE_METER = "storage" + ".bytes";
const MEDIA_METER = "media" + ".bytes";

function meterLabel(key: string, fallback: string, t: (key: string) => string): string {
  if (key === "sites") return t("platform.meterSites");
  if (key === "users") return t("platform.meterUsers");
  if (key === "content") return t("platform.meterContent");
  if (key === "content" + ".types") return t("platform.meterContentTypes");
  if (key === "content" + ".post") return t("platform.meterPosts");
  if (key === "content" + ".page") return t("platform.meterPages");
  if (key === "media" + ".files") return t("platform.meterMediaFiles");
  if (key === STORAGE_METER) return t("storageUsage.limitLabel");
  if (key === MEDIA_METER) return t("platform.meterMedia");
  if (key === "plugins") return t("platform.meterPlugins");
  if (key === "roles") return t("platform.meterRoles");
  if (key === "feature" + ".comments") return t("platform.featureComments");
  if (key === "feature" + ".themeUpload") return t("platform.featureThemeUpload");
  if (key === "feature" + ".design") return t("platform.featureDesign");
  if (key === "feature" + ".roles") return t("platform.featureRoles");
  if (key === "feature" + ".responsiveImages") return t("platform.featureResponsiveImages");
  if (key === "feature" + ".securityAdvanced") return t("platform.featureSecurityAdvanced");
  if (key === "feature" + ".securityHeaders") return t("platform.featureSecurityHeaders");
  if (key === "feature" + ".securityAdminPath") return t("platform.featureSecurityAdminPath");
  if (key === "feature" + ".securityAudit") return t("platform.featureSecurityAudit");
  if (key === "feature" + ".pwa") return t("platform.featurePwa");
  if (key === "feature" + ".redirects") return t("platform.featureRedirects");
  if (key === "feature" + ".permalinks") return t("platform.featurePermalinks");
  if (key === "feature" + ".placeholders") return t("platform.featurePlaceholders");
  if (key === "feature" + ".emails") return t("platform.featureEmails");
  if (key === "feature" + ".languages") return t("platform.featureLanguages");
  if (key === "feature" + ".webhooks") return t("platform.featureWebhooks");
  if (key === "feature" + ".api") return t("platform.featureApi");
  if (key === "feature" + ".ai") return t("platform.featureAi");
  if (key === "feature" + ".cdn") return t("platform.featureCdn");
  if (key === "feature" + ".trash") return t("platform.featureTrash");
  if (key === "feature" + ".tools") return t("platform.featureTools");
  if (key === "feature" + ".plugins") return t("platform.featurePlugins");
  if (key === "feature" + ".customDomains") return t("platform.featureCustomDomains");
  if (key === "feature" + ".managedDns") return t("platform.featureManagedDns");
  if (key === "domains" + ".custom") return t("platform.meterCustomDomains");
  return fallback;
}

function toField(meter: QuotaMeter): string {
  if (meter.unit === "flag") return meter.limit === 0 ? "0" : "1";
  if (meter.limit === null) return "";
  if (meter.unit === "bytes") return String(Math.round(meter.limit / (1024 * 1024)));
  return String(meter.limit);
}

function formatUsed(meter: QuotaMeter, unknown: string): string {
  if (meter.used === null) return unknown;
  if (meter.key === STORAGE_METER) return formatStorageBytes(meter.used);
  if (meter.unit === "bytes") return `${Math.round(meter.used / (1024 * 1024))} MB`;
  return String(meter.used);
}

export default function QuotaLimitsCard({
  endpoint,
  meters,
  title,
  intro,
  showUsage = true,
  storageUsageBytes,
}: {
  endpoint: string;
  meters: QuotaMeter[];
  title?: string;
  intro?: string;
  showUsage?: boolean;
  storageUsageBytes?: number | null;
}) {
  const { t } = useT();
  const idBase = useId();
  const [rows, setRows] = useState(meters);
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(meters.map((meter) => [meter.key, toField(meter)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    const limits: Record<string, number | null> = {};
    for (const meter of rows) {
      const raw = (draft[meter.key] ?? "").trim();
      if (meter.unit === "flag") {
        limits[meter.key] = raw === "0" ? 0 : 1;
        continue;
      }
      if (!raw) {
        limits[meter.key] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        setError(t("platform.limitsInvalid"));
        return;
      }
      limits[meter.key] = meter.unit === "bytes" ? value * 1024 * 1024 : value;
    }
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limits }),
      });
      const body = (await res.json()) as { error?: string; quotas?: { meters: QuotaMeter[] } };
      if (!res.ok || !body.quotas) throw new Error(body.error ?? t("platform.limitsSaveFailed"));
      setRows(body.quotas.meters);
      setDraft(Object.fromEntries(body.quotas.meters.map((meter) => [meter.key, toField(meter)])));
      setNotice(t("platform.limitsSaved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("platform.limitsSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const limitRows = rows.filter((meter) => meter.unit !== "flag");
  const featureRows = rows.filter((meter) => meter.unit === "flag");

  function limitInput(meter: QuotaMeter) {
    const input = (
      <input
        id={`${idBase}-${meter.key}`}
        className="jf-input"
        inputMode="numeric"
        value={draft[meter.key] ?? ""}
        placeholder={t("platform.limitsUnlimited")}
        onChange={(event) => setDraft((current) => ({ ...current, [meter.key]: event.target.value }))}
      />
    );
    if (meter.unit !== "bytes") return input;
    return (
      <div className="jf-inputgroup">
        {input}
        <span className="jf-inputgroup__suffix">{t("platform.unitMegabytes")}</span>
      </div>
    );
  }

  return (
    <form className="jf-card" onSubmit={(event) => void onSave(event)}>
      <div className="jf-card__head">
        <h2 className="jf-card__title">{title ?? t("platform.limits")}</h2>
      </div>
      <div className="jf-card__body jf-stack">
        <p className="jf-field__hint">{intro ?? t("platform.limitsIntro")}</p>
        {error ? <div className="jf-alert jf-alert--error" role="alert">{error}</div> : null}
        {notice ? <div className="jf-alert jf-alert--success" role="status">{notice}</div> : null}
        {limitRows.length > 0 ? (
          <div className="jf-grid jf-quota-grid">
            {limitRows.map((meter) => (
              <div className="jf-field" key={meter.key}>
                <label className="jf-field__label" htmlFor={`${idBase}-${meter.key}`}>
                  {meterLabel(meter.key, meter.label, t)}
                </label>
                {limitInput(meter)}
                {showUsage || meter.unit === "bytes" ? (
                  <span className="jf-field__hint">
                    {showUsage ? `${t("platform.limitsUsed")}: ${formatUsed(meter.key === STORAGE_METER && storageUsageBytes !== undefined ? { ...meter, used: storageUsageBytes } : meter, t("platform.limitsUsageUnknown"))}` : ""}
                    {showUsage && meter.unit === "bytes" ? ". " : ""}
                    {meter.unit === "bytes" ? t("platform.limitsMediaHint") : ""}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {featureRows.length > 0 ? (
          <>
            {limitRows.length > 0 ? <hr className="jf-divider" /> : null}
            <fieldset className="jf-quota-features">
              <legend className="jf-section-title">{t("platform.features")}</legend>
              <p className="jf-field__hint">{t("platform.featuresIntro")}</p>
              <div className="jf-quota-features__grid">
                {featureRows.map((meter) => (
                  <label className="jf-checkrow" key={meter.key}>
                    <input
                      type="checkbox"
                      checked={(draft[meter.key] ?? "1") !== "0"}
                      onChange={(event) => setDraft((current) => ({ ...current, [meter.key]: event.target.checked ? "1" : "0" }))}
                    />
                    <span>{meterLabel(meter.key, meter.label, t)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        <div className="jf-row">
          <button className="jf-btn jf-btn--primary" type="submit" disabled={saving || rows.length === 0}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </form>
  );
}
