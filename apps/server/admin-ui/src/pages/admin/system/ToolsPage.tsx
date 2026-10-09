import { readStaticExportJson, pollStaticExportJob } from "../../../lib/static-export-request";
import { SearchToolsCard } from "../../../components/SearchToolsCard";
import { useEffect, useRef, useState } from "react";
import { manualRestartKey, serviceUnitName } from "../../../lib/restart-notice.js";
import { waitForSiteRestart } from "../../../lib/wait-for-restart.js";
import { useFeatureEnabled, useSession } from "@components/SessionProvider";
import { useT } from "../../../i18n/I18nProvider";

interface ImportResult {
  ok: boolean;
  imported?: { posts: number; pages: number; skipped: number };
  errors?: string[];
  error?: string;
}

interface CacheSettings {
  enabled: boolean;
  driver: "memory" | "filesystem";
  ttlSeconds: number;
  dir: string;
  redisUrl: string;
  defaultDir: string;
}

interface GzipSettings {
  enabled: boolean;
  level: number;
  minBytes: number;
}

interface BrowserCacheSettings {
  enabled: boolean;
  htmlMaxAge: number;
  staticMaxAge: number;
  staleWhileRevalidate: number;
}

interface RevalidateSettings {
  enabled: boolean;
  objects: {
    pages: boolean;
    content: boolean;
    menus: boolean;
    theme: boolean;
    cssProviders: boolean;
    site: boolean;
  };
}

interface PerformanceSettingsResponse {
  settings: {
    cache: CacheSettings;
    gzip: GzipSettings;
    browserCache: BrowserCacheSettings;
    revalidate: RevalidateSettings;
  };
  runtime: {
    active: boolean;
    driver: string;
    ttlSeconds: number;
    gzip: boolean;
    browserCache: boolean;
    revalidate: boolean;
  };
  envPath: string;
}

interface StaticExportStatus {
  hasExport: boolean;
  running?: boolean;
  lastRun: {
    generatedAt: string;
    mode: string;
    pages: number;
    assets: number;
    publicUrl: string;
  } | null;
}

interface StaticExportSettings {
  storageDriver: "local" | "s3";
  enabled: boolean;
  dir: string;
  baseUrl: string;
  crawlUrl: string;
  originUrl: string;
  allowedOrigins: string;
  maxPages: number;
  concurrency: number;
  auto: boolean;
  debounceMs: number;
}

interface StaticExportSettingsResponse {
  settings: StaticExportSettings;
  runtime: {
    outDir: string;
    publicUrl: string;
    autoArmed: boolean;
    revalidateEnabled: boolean;
    appUrl: string;
  };
  envPath: string;
  siteEnabled?: boolean;
}

interface StaticExportRunResponse {
  jobId?: string;
  ok: boolean;
  error?: string;
  log?: string[];
  summary?: {
    pages: number;
    assets: number;
    bytes: number;
    pruned: number;
    outDir: string;
    durationMs: number;
    hitPageLimit: boolean;
    errors: string[];
  };
}

interface PerformanceStatsResponse {
  enabled: boolean;
  gzip: GzipSettings;
  browserCache: BrowserCacheSettings;
  revalidate?: RevalidateSettings;
  stats: {
    hits: number;
    misses: number;
    sets: number;
    deletes: number;
    invalidations: number;
    clears: number;
    hitRate: number | null;
  };
  storage: { keyCount: number; totalBytes: number; sampleKeys: string[] };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function logVariant(line: string): string {
  if (line.startsWith("✓")) return " jf-log__line--ok";
  if (line.startsWith("✗")) return " jf-log__line--fail";
  if (line.startsWith("⚠")) return " jf-log__line--warn";
  if (line.startsWith("↻")) return " jf-log__line--info";
  return "";
}

export default function ToolsPage() {
  const { t } = useT();
  const installationRoot = useSession().session?.installationRoot === true;
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const [perfLoading, setPerfLoading] = useState(true);
  const [cache, setCache] = useState<CacheSettings>({
    enabled: false,
    driver: "filesystem",
    ttlSeconds: 300,
    dir: "",
    redisUrl: "",
    defaultDir: "./.cache",
  });
  const [gzip, setGzip] = useState<GzipSettings>({
    enabled: false,
    level: 6,
    minBytes: 1024,
  });
  const [browserCache, setBrowserCache] = useState<BrowserCacheSettings>({
    enabled: false,
    htmlMaxAge: 60,
    staticMaxAge: 86400,
    staleWhileRevalidate: 300,
  });
  const [revalidate, setRevalidate] = useState<RevalidateSettings>({
    enabled: false,
    objects: {
      pages: true,
      content: true,
      menus: true,
      theme: true,
      cssProviders: true,
      site: true,
    },
  });
  const [envPath, setEnvPath] = useState("");
  const [runtime, setRuntime] = useState<PerformanceSettingsResponse["runtime"] | null>(null);
  const [perfSaving, setPerfSaving] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [perfError, setPerfError] = useState<string | null>(null);
  const [perfSaved, setPerfSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const [restartMethod, setRestartMethod] = useState<string | undefined>();
  const [restartTarget, setRestartTarget] = useState<string | undefined>();
  const [log, setLog] = useState<string[]>([]);
  const [perfStats, setPerfStats] = useState<PerformanceStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [sxStatus, setSxStatus] = useState<StaticExportStatus | null>(null);
  const [sxLog, setSxLog] = useState<string[]>([]);
  const [sxRunning, setSxRunning] = useState(false);
  const [sxError, setSxError] = useState<string | null>(null);
  const [sxSettings, setSxSettings] = useState<StaticExportSettings | null>(null);
  const [sxRuntimeInfo, setSxRuntimeInfo] = useState<
    StaticExportSettingsResponse["runtime"] | null
  >(null);
  const [sxEnvPath, setSxEnvPath] = useState("");
  const [sxSaving, setSxSaving] = useState(false);
  const [sxSaved, setSxSaved] = useState(false);
  const [sxSiteEnabled, setSxSiteEnabled] = useState(true);
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const suggestedOrigin = sxRuntimeInfo?.appUrl || browserOrigin;

  async function loadPerfStats() {
    setStatsLoading(true);
    try {
      for (const url of ["/api/performance/stats", "/api/cache/stats"]) {
        const res = await fetch(url);
        if (res.ok) {
          setPerfStats((await res.json()) as PerformanceStatsResponse);
          return;
        }
      }
    } catch {
      // non-fatal
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadPerformanceSettings() {
    setPerfError(null);
    for (const url of ["/api/performance/settings", "/api/cache/settings"]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = (await res.json()) as PerformanceSettingsResponse;
        setCache(data.settings.cache);
        setGzip(data.settings.gzip);
        setBrowserCache(data.settings.browserCache);
        if (data.settings.revalidate) setRevalidate(data.settings.revalidate);
        setEnvPath(data.envPath);
        setRuntime(data.runtime);
        return;
      } catch {
        // try next endpoint
      }
    }
    setPerfError(t("tools.performance.loadFailed"));
  }

  async function loadSxStatus() {
    try {
      const [statusRes, settingsRes] = await Promise.all([
        fetch("/api/static-export/status"),
        fetch("/api/static-export/settings"),
      ]);
      if (statusRes.ok) setSxStatus((await statusRes.json()) as StaticExportStatus);
      if (settingsRes.ok) {
        const data = (await settingsRes.json()) as StaticExportSettingsResponse;
        setSxSettings(data.settings);
        setSxRuntimeInfo(data.runtime);
        setSxEnvPath(data.envPath);
        setSxSiteEnabled(data.siteEnabled !== false);
      }
    } catch {
      // non-fatal — the card renders "no export yet"
    }
  }

  async function saveSxSettings() {
    if (!sxSettings) return;
    setSxError(null);
    setSxSaved(false);
    setSxSaving(true);
    try {
      const res = await fetch("/api/static-export/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sxSettings),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
      } & Partial<StaticExportSettingsResponse>;
      if (!res.ok || !data.ok) {
        setSxError(data.error ?? t("tools.staticExport.saveFailed"));
        return;
      }
      if (data.settings) setSxSettings(data.settings);
      if (data.runtime) setSxRuntimeInfo(data.runtime);
      if (typeof data.siteEnabled === "boolean") setSxSiteEnabled(data.siteEnabled);
      setSxSaved(true);
    } catch (e) {
      setSxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSxSaving(false);
    }
  }

  async function saveSiteExport() {
    setSxError(null);
    setSxSaved(false);
    setSxSaving(true);
    try {
      const res = await fetch("/api/static-export/site", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: sxSiteEnabled }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        siteEnabled?: boolean;
      };
      if (!res.ok || !data.ok) {
        setSxError(data.error ?? t("tools.staticExport.saveFailed"));
        return;
      }
      if (typeof data.siteEnabled === "boolean") setSxSiteEnabled(data.siteEnabled);
      setSxSaved(true);
    } catch (e) {
      setSxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSxSaving(false);
    }
  }

  async function runStaticExport(mode: "full" | "incremental") {
    setSxError(null);
    setSxLog([]);
    setSxRunning(true);
    try {
      const res = await fetch("/api/static-export/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, async: true }),
      });
      const responseError = t("tools.staticExport.responseUnavailable", { status: res.status });
      let data = await readStaticExportJson<StaticExportRunResponse>(res, responseError);
      if (res.status === 202 && data.jobId) {
        const job = await pollStaticExportJob(data.jobId, async () => {
          const status = await fetch("/api/static-export/status", { cache: "no-store" });
          const message = t("tools.staticExport.responseUnavailable", { status: status.status });
          if (!status.ok) throw new Error(message);
          return readStaticExportJson(status, message);
        }, (job) => setSxLog(job.log), t("tools.staticExport.pollingUnavailable"));
        data = { ok: job.state === "completed", summary: job.summary, error: job.error, log: job.log };
      }
      setSxLog(data.log ?? []);
      if (!res.ok || !data.ok) {
        setSxError(data.error ?? t("tools.staticExport.exportFinishedWithErrors"));
      }
      await loadSxStatus();
    } catch (e) {
      setSxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSxRunning(false);
    }
  }

  async function clearStaticExport() {
    const dir = installationRoot
      ? (sxRuntimeInfo?.outDir ?? t("tools.staticExport.theExportFolder"))
      : t("tools.staticExport.thisWebsiteExport");
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("tools.staticExport.clearConfirm", { dir }))
    ) {
      return;
    }
    setSxError(null);
    setSxLog([]);
    setSxRunning(true);
    try {
      const res = await fetch("/api/static-export/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as { ok?: boolean; removed?: boolean; reason?: string };
      if (!res.ok || !data.ok) {
        setSxError(data.reason ?? t("tools.staticExport.clearFailed"));
      } else {
        setSxLog([
          data.removed
            ? `✓ ${t("tools.staticExport.deleted", { dir })}`
            : `✓ ${t("tools.staticExport.nothingToClear")}`,
        ]);
      }
      await loadSxStatus();
    } catch (e) {
      setSxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSxRunning(false);
    }
  }

  useEffect(() => {
    void loadSxStatus();
  }, []);

  useEffect(() => {
    if (!installationRoot) {
      setPerfLoading(false);
      return;
    }
    void loadPerformanceSettings().finally(() => setPerfLoading(false));
    void loadPerfStats();
  }, [installationRoot]);

  function addLog(line: string) {
    setLog((l) => [...l, line]);
  }

  async function importWordPress(file: File) {
    setImporting(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/wordpress", { method: "POST", body: form });
      setResult((await res.json()) as ImportResult);
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setImporting(false);
    }
  }

  async function savePerformanceSettings() {
    setPerfError(null);
    setPerfSaved(false);
    setRestartFailed(false);
    setLog([]);
    setPerfSaving(true);

    const payload = {
      cache: {
        enabled: cache.enabled,
        driver: cache.driver,
        ttlSeconds: Number(cache.ttlSeconds),
        dir: cache.driver === "filesystem" ? cache.dir || cache.defaultDir : undefined,
        redisUrl: cache.redisUrl || undefined,
      },
      gzip: {
        enabled: gzip.enabled,
        level: Number(gzip.level),
        minBytes: Number(gzip.minBytes),
      },
      browserCache: {
        enabled: browserCache.enabled,
        htmlMaxAge: Number(browserCache.htmlMaxAge),
        staticMaxAge: Number(browserCache.staticMaxAge),
        staleWhileRevalidate: Number(browserCache.staleWhileRevalidate),
      },
      revalidate: {
        enabled: revalidate.enabled,
        objects: { ...revalidate.objects },
      },
    };

    try {
      let res = await fetch("/api/performance/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 404) {
        res = await fetch("/api/cache/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        restarting?: boolean;
        restartRequired?: boolean;
        restartMethod?: string;
        restartTarget?: string;
        settings?: PerformanceSettingsResponse["settings"];
      };

      if (!res.ok) {
        throw new Error(data.error ?? t("tools.performance.saveFailed"));
      }

      if (data.settings) {
        setCache(data.settings.cache);
        setGzip(data.settings.gzip);
        setBrowserCache(data.settings.browserCache);
        if (data.settings.revalidate) setRevalidate(data.settings.revalidate);
      }
      setPerfSaved(true);
      addLog(`✓ ${t("tools.performance.settingsWritten")}`);

      if (data.restarting) {
        setPerfSaving(false);
        setRestarting(true);
        await waitForSiteRestart(t, addLog);
        setRestarting(false);
      } else if (data.restartRequired) {
        setRestartMethod(data.restartMethod);
        setRestartTarget(data.restartTarget);
        setRestartFailed(true);
        addLog(`⚠ ${t(manualRestartKey("tools", "log", data.restartMethod), { unit: serviceUnitName(data.restartTarget) })}`);
      }
    } catch (e) {
      setPerfError(e instanceof Error ? e.message : String(e));
      addLog(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPerfSaving(false);
    }
  }

  async function clearCache() {
    setPerfError(null);
    setCacheClearing(true);
    try {
      for (const url of ["/api/performance/clear", "/api/cache/clear"]) {
        const res = await fetch(url, { method: "POST" });
        const data = (await res.json()) as { ok?: boolean; error?: string; enabled?: boolean };
        if (!res.ok) continue;
        setRuntime((r) => (r ? { ...r, active: data.enabled ?? cache.enabled } : r));
        addLog(
          `✓ ${
            data.enabled === false
              ? t("tools.performance.cacheClearedDisabled")
              : t("tools.performance.cacheCleared")
          }`,
        );
        await loadPerfStats();
        return;
      }
      throw new Error(t("tools.performance.clearFailed"));
    } catch (e) {
      setPerfError(e instanceof Error ? e.message : String(e));
    } finally {
      setCacheClearing(false);
    }
  }

  const perfBusy = perfSaving || restarting;

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("tools.title")}</h1>
          <p>{t("tools.subtitle")}</p>
        </div>
      </header>

      {installationRoot ? (
      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("tools.performance.title")}</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            {t("tools.performance.description")}{" "}
            <code className="jf-code">X-Jf-Cache</code>,{" "}
            <code className="jf-code">X-Jf-Page-Cache</code>,{" "}
            <code className="jf-code">Content-Encoding</code>, {t("tools.performance.descriptionAnd")}{" "}
            <code className="jf-code">Cache-Control</code> {t("tools.performance.descriptionSuffix")}
          </p>

          {!perfLoading && perfStats && (
            <div className="jf-stack" style={{ gap: "0.75rem" }}>
              <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <span className={`jf-badge jf-badge--${perfStats.enabled ? "ok" : "warn"}`}>
                  {perfStats.enabled
                    ? t("tools.performance.objectCacheOn")
                    : t("tools.performance.objectCacheOff")}
                </span>
                <span className={`jf-badge jf-badge--${perfStats.gzip.enabled ? "ok" : "warn"}`}>
                  {perfStats.gzip.enabled
                    ? t("tools.performance.gzipOn")
                    : t("tools.performance.gzipOff")}
                </span>
                <span
                  className={`jf-badge jf-badge--${perfStats.browserCache.enabled ? "ok" : "warn"}`}
                >
                  {perfStats.browserCache.enabled
                    ? t("tools.performance.browserCacheOn")
                    : t("tools.performance.browserCacheOff")}
                </span>
                {perfStats.revalidate && (
                  <span
                    className={`jf-badge jf-badge--${perfStats.revalidate.enabled ? "ok" : "warn"}`}
                  >
                    {perfStats.revalidate.enabled
                      ? t("tools.performance.revalidateOn")
                      : t("tools.performance.revalidateOff")}
                  </span>
                )}
                <span className="jf-badge jf-badge--info">
                  {t("tools.performance.hitsMisses", {
                    hits: perfStats.stats.hits,
                    misses: perfStats.stats.misses,
                  })}
                  {perfStats.stats.hitRate !== null
                    ? t("tools.performance.hitRateSuffix", { rate: perfStats.stats.hitRate })
                    : ""}
                </span>
                <span className="jf-badge jf-badge--info">
                  {t("tools.performance.keysStorage", {
                    count: perfStats.storage.keyCount,
                    size: formatBytes(perfStats.storage.totalBytes),
                  })}
                </span>
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost"
                  onClick={() => loadPerfStats()}
                  disabled={statsLoading}
                >
                  {statsLoading
                    ? t("tools.performance.refreshing")
                    : `↻ ${t("tools.performance.refreshStats")}`}
                </button>
              </div>
              {perfStats.storage.sampleKeys.length > 0 && (
                <details>
                  <summary className="jf-field__hint" style={{ cursor: "pointer" }}>
                    {t("tools.performance.sampleCacheFiles", {
                      count: perfStats.storage.sampleKeys.length,
                    })}
                  </summary>
                  <ul
                    style={{
                      margin: "0.4rem 0 0",
                      paddingInlineStart: "1.1rem",
                      fontSize: "0.85rem",
                    }}
                  >
                    {perfStats.storage.sampleKeys.map((key) => (
                      <li key={key}>
                        <code>{key}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {perfLoading ? (
            <div className="jf-skeleton" style={{ height: 420 }} />
          ) : (
            <>
              <hr className="jf-divider" />

              <h3 className="jf-card__subtitle">{t("tools.performance.objectCacheHeading")}</h3>
              <p className="jf-field__hint">
                {t("tools.performance.objectCacheHint")}
              </p>

              <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <span className={`jf-badge jf-badge--${cache.enabled ? "ok" : "warn"}`}>
                  {cache.enabled ? t("tools.status.enabled") : t("tools.status.disabled")}
                </span>
                <span className="jf-badge jf-badge--info">{cache.driver}</span>
                {runtime !== null && runtime.active !== cache.enabled && (
                  <span className="jf-badge jf-badge--warn">{t("tools.performance.restartRequiredBadge")}</span>
                )}
              </div>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={cache.enabled}
                  onChange={(e) => setCache((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>{t("tools.performance.enableObjectCache")}</span>
              </label>

              <div className="jf-grid jf-grid--2">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-cache-driver">
                    {t("tools.performance.driverLabel")}
                  </label>
                  <select
                    id="jf-cache-driver"
                    className="jf-input"
                    value={cache.driver}
                    onChange={(e) =>
                      setCache((s) => ({
                        ...s,
                        driver: e.target.value as "memory" | "filesystem",
                      }))
                    }
                    disabled={perfBusy}
                  >
                    <option value="filesystem">{t("tools.performance.driverFilesystem")}</option>
                    <option value="memory">{t("tools.performance.driverMemory")}</option>
                  </select>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-cache-ttl">
                    {t("tools.performance.ttlLabel")}
                  </label>
                  <input
                    id="jf-cache-ttl"
                    className="jf-input"
                    type="number"
                    min={0}
                    max={86400}
                    value={cache.ttlSeconds}
                    onChange={(e) =>
                      setCache((s) => ({ ...s, ttlSeconds: Number(e.target.value) || 0 }))
                    }
                    disabled={perfBusy}
                  />
                </div>
              </div>

              {cache.driver === "filesystem" && (
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-cache-dir">
                    {t("tools.performance.cacheDirLabel")}
                  </label>
                  <input
                    id="jf-cache-dir"
                    className="jf-input"
                    value={cache.dir || cache.defaultDir}
                    placeholder={cache.defaultDir}
                    onChange={(e) => setCache((s) => ({ ...s, dir: e.target.value }))}
                    disabled={perfBusy}
                  />
                </div>
              )}

              <hr className="jf-divider" />

              <h3 className="jf-card__subtitle">{t("tools.performance.revalidateHeading")}</h3>
              <p className="jf-field__hint">
                {t("tools.performance.revalidateHint1")}{" "}
                <code className="jf-code">cache.revalidated</code>{" "}
                {t("tools.performance.revalidateHint2")}
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={revalidate.enabled}
                  onChange={(e) => setRevalidate((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>{t("tools.performance.revalidateCheckbox")}</span>
              </label>

              <div
                className="jf-grid jf-grid--2"
                style={{ opacity: revalidate.enabled ? 1 : 0.55 }}
              >
                {(
                  [
                    ["pages", t("tools.performance.revalidateObjects.pages")],
                    ["content", t("tools.performance.revalidateObjects.content")],
                    ["menus", t("tools.performance.revalidateObjects.menus")],
                    ["theme", t("tools.performance.revalidateObjects.theme")],
                    ["cssProviders", t("tools.performance.revalidateObjects.cssProviders")],
                    ["site", t("tools.performance.revalidateObjects.site")],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="jf-checkrow">
                    <input
                      type="checkbox"
                      checked={revalidate.objects[key]}
                      onChange={(e) =>
                        setRevalidate((s) => ({
                          ...s,
                          objects: { ...s.objects, [key]: e.target.checked },
                        }))
                      }
                      disabled={perfBusy || !revalidate.enabled}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>

              <hr className="jf-divider" />

              <h3 className="jf-card__subtitle">{t("tools.performance.gzipHeading")}</h3>
              <p className="jf-field__hint">
                {t("tools.performance.gzipHint")}
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={gzip.enabled}
                  onChange={(e) => setGzip((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>{t("tools.performance.enableGzip")}</span>
              </label>

              <div className="jf-grid jf-grid--2">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-gzip-level">
                    {t("tools.performance.compressionLevelLabel")}
                  </label>
                  <input
                    id="jf-gzip-level"
                    className="jf-input"
                    type="number"
                    min={1}
                    max={9}
                    value={gzip.level}
                    onChange={(e) => setGzip((s) => ({ ...s, level: Number(e.target.value) || 6 }))}
                    disabled={perfBusy || !gzip.enabled}
                  />
                  <p className="jf-field__hint">{t("tools.performance.compressionLevelHint")}</p>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-gzip-min">
                    {t("tools.performance.minSizeLabel")}
                  </label>
                  <input
                    id="jf-gzip-min"
                    className="jf-input"
                    type="number"
                    min={256}
                    max={65536}
                    value={gzip.minBytes}
                    onChange={(e) =>
                      setGzip((s) => ({ ...s, minBytes: Number(e.target.value) || 1024 }))
                    }
                    disabled={perfBusy || !gzip.enabled}
                  />
                  <p className="jf-field__hint">{t("tools.performance.minSizeHint")}</p>
                </div>
              </div>

              <hr className="jf-divider" />

              <h3 className="jf-card__subtitle">{t("tools.performance.browserCacheHeading")}</h3>
              <p className="jf-field__hint">
                {t("tools.performance.browserCacheHint1")} <code className="jf-code">Cache-Control</code>{" "}
                {t("tools.performance.browserCacheHint2")} <code className="jf-code">no-store</code>.
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={browserCache.enabled}
                  onChange={(e) => setBrowserCache((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>{t("tools.performance.enableBrowserCache")}</span>
              </label>

              <div className="jf-grid jf-grid--3">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-bc-html">
                    {t("tools.performance.htmlMaxAgeLabel")}
                  </label>
                  <input
                    id="jf-bc-html"
                    className="jf-input"
                    type="number"
                    min={0}
                    max={86400}
                    value={browserCache.htmlMaxAge}
                    onChange={(e) =>
                      setBrowserCache((s) => ({
                        ...s,
                        htmlMaxAge: Number(e.target.value) || 0,
                      }))
                    }
                    disabled={perfBusy || !browserCache.enabled}
                  />
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-bc-static">
                    {t("tools.performance.staticMaxAgeLabel")}
                  </label>
                  <input
                    id="jf-bc-static"
                    className="jf-input"
                    type="number"
                    min={0}
                    max={31536000}
                    value={browserCache.staticMaxAge}
                    onChange={(e) =>
                      setBrowserCache((s) => ({
                        ...s,
                        staticMaxAge: Number(e.target.value) || 0,
                      }))
                    }
                    disabled={perfBusy || !browserCache.enabled}
                  />
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-bc-swr">
                    {t("tools.performance.swrLabel")}
                  </label>
                  <input
                    id="jf-bc-swr"
                    className="jf-input"
                    type="number"
                    min={0}
                    max={86400}
                    value={browserCache.staleWhileRevalidate}
                    onChange={(e) =>
                      setBrowserCache((s) => ({
                        ...s,
                        staleWhileRevalidate: Number(e.target.value) || 0,
                      }))
                    }
                    disabled={perfBusy || !browserCache.enabled}
                  />
                </div>
              </div>

              {envPath && (
                <p className="jf-field__hint">
                  {t("tools.performance.configFile")}{" "}
                  <code className="jf-code">{envPath}</code>
                </p>
              )}

              <div className="jf-row">
                <button
                  className="jf-btn jf-btn--primary"
                  onClick={savePerformanceSettings}
                  disabled={perfBusy || cacheClearing}
                >
                  {perfSaving
                    ? t("common.saving")
                    : restarting
                      ? t("tools.performance.restartingLabel")
                      : t("tools.performance.saveAndRestart")}
                </button>
                <button
                  className="jf-btn jf-btn--ghost"
                  onClick={clearCache}
                  disabled={perfBusy || cacheClearing}
                >
                  {cacheClearing ? t("tools.performance.clearing") : t("tools.performance.clearObjectCache")}
                </button>
                {perfSaved && !perfBusy && (
                  <span className="jf-status jf-status--saved">✓ {t("common.saved")}</span>
                )}
                {perfError && <span className="jf-status jf-status--error">{perfError}</span>}
              </div>

              {restartFailed && (
                <div className="jf-banner jf-banner--warn">
                  <span className="jf-banner__icon" aria-hidden="true">
                    ⚠️
                  </span>
                  <div>
                    <div className="jf-banner__title">{t("tools.manualRestartTitle")}</div>
                    <div className="jf-banner__sub">
                      {t(manualRestartKey("tools", "body", restartMethod), { unit: serviceUnitName(restartTarget) })}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      ) : null}

      {installationRoot && log.length > 0 && (
        <div className="jf-log">
          <p className="jf-log__label">{t("tools.performance.logLabel")}</p>
          {log.map((line, i) => (
            <p key={i} className={`jf-log__line${logVariant(line)}`}>
              {line}
            </p>
          ))}
        </div>
      )}

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("tools.wordpress.title")}</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            {t("tools.wordpress.description")}
          </p>

          <input
            ref={fileRef}
            type="file"
            accept=".xml"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importWordPress(f);
            }}
          />

          <div className="jf-row">
            <button
              className="jf-btn jf-btn--primary"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
            >
              {importing ? t("tools.wordpress.importing") : t("tools.wordpress.uploadButton")}
            </button>
          </div>

          {result &&
            (result.ok ? (
              <div className="jf-alert jf-alert--success">
                <div>
                  <strong>✓ {t("tools.wordpress.importComplete")}</strong>
                  <ul style={{ margin: "0.4rem 0 0", paddingInlineStart: "1.1rem" }}>
                    <li>{t("tools.wordpress.postsImported", { count: result.imported?.posts ?? 0 })}</li>
                    <li>{t("tools.wordpress.pagesImported", { count: result.imported?.pages ?? 0 })}</li>
                    <li>{t("tools.wordpress.skipped", { count: result.imported?.skipped ?? 0 })}</li>
                  </ul>
                  {result.errors && result.errors.length > 0 && (
                    <p style={{ margin: "0.4rem 0 0" }}>
                      {t("tools.wordpress.itemsHadErrors", { count: result.errors.length })}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="jf-alert jf-alert--error" role="alert">
                <strong>{t("tools.wordpress.importFailed")}</strong>&nbsp;{result.error}
              </div>
            ))}
        </div>
      </div>

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("tools.staticExport.title")}</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            {sxSettings?.storageDriver === "s3" ? t("tools.staticExport.descriptionHtmlOnly") : <>
            {t("tools.staticExport.description1")} <code className="jf-code">sitemap.xml</code>
            , <code className="jf-code">robots.txt</code> {t("tools.staticExport.description2")}{" "}
            <code className="jf-code">theme.css</code> {t("tools.staticExport.description3")}{" "}
            <code className="jf-code">docs/STATIC-EXPORT.md</code> {t("tools.staticExport.description4")}
            </>}
          </p>

          <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <span className={`jf-badge jf-badge--${sxRuntimeInfo?.autoArmed ? "ok" : "warn"}`}>
              {sxRuntimeInfo?.autoArmed
                ? t("tools.staticExport.autoRebuildArmed")
                : sxSettings?.auto
                  ? t("tools.staticExport.autoRebuildOnIdle")
                  : t("tools.staticExport.autoRebuildOff")}
            </span>
            {sxSettings?.auto && sxRuntimeInfo && !sxRuntimeInfo.revalidateEnabled && (
              <span className="jf-badge jf-badge--warn">{t("tools.staticExport.needsRevalidateEnv")}</span>
            )}
            {sxStatus?.lastRun ? (
              <>
                <span className="jf-badge jf-badge--info">
                  {t("tools.staticExport.lastRun", {
                    date: new Date(sxStatus.lastRun.generatedAt).toLocaleString(),
                    mode: sxStatus.lastRun.mode,
                  })}
                </span>
                <span className="jf-badge jf-badge--info">
                  {t("tools.staticExport.pagesAssets", {
                    pages: sxStatus.lastRun.pages,
                    assets: sxStatus.lastRun.assets,
                  })}
                </span>
              </>
            ) : (
              <span className="jf-badge jf-badge--warn">{t("tools.staticExport.neverRun")}</span>
            )}
          </div>

          {installationRoot && sxSettings && (
            <>
              <h3 className="jf-card__subtitle">{t("tools.staticExport.configurationHeading")}</h3>
              <p className="jf-field__hint">
                {t("tools.staticExport.savedToPrefix", { path: sxEnvPath || ".env" })}{" "}
                <code className="jf-code">STATIC_EXPORT_*</code>{" "}
                {t("tools.staticExport.savedToSuffix")}
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={sxSettings.enabled}
                  onChange={(e) => setSxSettings({ ...sxSettings, enabled: e.target.checked })}
                  disabled={sxSaving || sxRunning}
                />
                <span>
                  {t("tools.staticExport.enabledCheckboxText1")}{" "}
                  <strong>{t("tools.staticExport.clearExport")}</strong>{" "}
                  {t("tools.staticExport.enabledCheckboxText2")}
                </span>
              </label>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-storage">
                  {t("tools.staticExport.storageLabel")}
                </label>
                <select
                  id="jf-sx-storage"
                  className="jf-input"
                  value={sxSettings.storageDriver ?? "local"}
                  onChange={(e) =>
                    setSxSettings({
                      ...sxSettings,
                      storageDriver: e.target.value as "local" | "s3",
                    })
                  }
                  disabled={sxSaving || sxRunning}
                >
                  <option value="local">{t("tools.staticExport.storageLocal")}</option>
                  <option value="s3">{t("tools.staticExport.storageS3")}</option>
                </select>
                <p className="jf-field__hint">{t("tools.staticExport.storageHint")}</p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-dir">
                  {t("tools.staticExport.outputDirLabel")}
                </label>
                <input
                  id="jf-sx-dir"
                  className="jf-input"
                  value={sxSettings.dir}
                  placeholder={t("tools.staticExport.outputDirPlaceholder")}
                  onChange={(e) => setSxSettings({ ...sxSettings, dir: e.target.value })}
                  disabled={sxSaving || sxRunning}
                />
                <p className="jf-field__hint">
                  {t("tools.staticExport.outputDirHint")}{" "}
                  <code className="jf-code">{sxRuntimeInfo?.outDir}</code>.
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-base">
                  {t("tools.staticExport.baseUrlLabel")}
                </label>
                <input
                  id="jf-sx-base"
                  className="jf-input"
                  value={sxSettings.baseUrl}
                  placeholder={t("tools.staticExport.baseUrlPlaceholder")}
                  onChange={(e) => setSxSettings({ ...sxSettings, baseUrl: e.target.value })}
                  disabled={sxSaving || sxRunning}
                />
                <p className="jf-field__hint">
                  {t("tools.staticExport.baseUrlHint1")} <code className="jf-code">sitemap.xml</code>{" "}
                  {t("tools.staticExport.baseUrlHint2")} <code className="jf-code">APP_URL</code>{" "}
                  {t("tools.staticExport.baseUrlHint3")}
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-crawl">
                  {t("tools.staticExport.crawlUrlLabel")}
                </label>
                <div className="jf-row" style={{ gap: "0.5rem", alignItems: "stretch" }}>
                  <input
                    id="jf-sx-crawl"
                    className="jf-input"
                    style={{ flex: 1 }}
                    value={sxSettings.crawlUrl}
                    placeholder={t("tools.staticExport.crawlUrlPlaceholder")}
                    onChange={(e) => setSxSettings({ ...sxSettings, crawlUrl: e.target.value })}
                    disabled={sxSaving || sxRunning}
                  />
                  <button
                    type="button"
                    className="jf-btn jf-btn--ghost"
                    onClick={() => setSxSettings({ ...sxSettings, crawlUrl: suggestedOrigin })}
                    disabled={sxSaving || sxRunning || !suggestedOrigin}
                  >
                    {t("tools.staticExport.useThisSite")}
                  </button>
                  {sxSettings.crawlUrl && (
                    <button
                      type="button"
                      className="jf-btn jf-btn--ghost"
                      onClick={() => setSxSettings({ ...sxSettings, crawlUrl: "" })}
                      disabled={sxSaving || sxRunning}
                    >
                      {t("tools.staticExport.clearButton")}
                    </button>
                  )}
                </div>
                <p className="jf-field__hint">
                  {t("tools.staticExport.crawlUrlHint1")} <code className="jf-code">APP_URL</code>{" "}
                  {t("tools.staticExport.crawlUrlHint2")}
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-origin">
                  {t("tools.staticExport.originLabel")}
                </label>
                <div className="jf-row" style={{ gap: "0.5rem", alignItems: "stretch" }}>
                  <input
                    id="jf-sx-origin"
                    className="jf-input"
                    style={{ flex: 1 }}
                    value={sxSettings.originUrl}
                    placeholder={t("tools.staticExport.originPlaceholder")}
                    onChange={(e) => setSxSettings({ ...sxSettings, originUrl: e.target.value })}
                    disabled={sxSaving || sxRunning}
                  />
                  <button
                    type="button"
                    className="jf-btn jf-btn--ghost"
                    onClick={() => setSxSettings({ ...sxSettings, originUrl: suggestedOrigin })}
                    disabled={sxSaving || sxRunning || !suggestedOrigin}
                  >
                    {t("tools.staticExport.useThisSite")}
                  </button>
                  {sxSettings.originUrl && (
                    <button
                      type="button"
                      className="jf-btn jf-btn--ghost"
                      onClick={() => setSxSettings({ ...sxSettings, originUrl: "" })}
                      disabled={sxSaving || sxRunning}
                    >
                      {t("tools.staticExport.clearButton")}
                    </button>
                  )}
                </div>
                <p className="jf-field__hint">
                  {t("tools.staticExport.originHint1")} <code className="jf-code">&lt;form&gt;</code>{" "}
                  {t("tools.staticExport.originHint2")} <code className="jf-code">fetch()</code>{" "}
                  {t("tools.staticExport.originHint3")}{" "}
                  <strong>{t("tools.staticExport.useThisSite")}</strong>{" "}
                  {t("tools.staticExport.originHint4")}{" "}
                  <code className="jf-code">
                    {suggestedOrigin || t("tools.staticExport.thisSitesOrigin")}
                  </code>
                  . {t("tools.staticExport.originHint5")} <code className="jf-code">/justflows-forms/*</code>{" "}
                  {t("tools.staticExport.originHint6")}{" "}
                  <code className="jf-code">/justflows-comments/*</code>{" "}
                  {t("tools.staticExport.originHint7")}
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-cors">
                  {t("tools.staticExport.corsLabel")}
                </label>
                <input
                  id="jf-sx-cors"
                  className="jf-input"
                  value={sxSettings.allowedOrigins}
                  placeholder="https://www.example.com, https://staging.example.com"
                  onChange={(e) => setSxSettings({ ...sxSettings, allowedOrigins: e.target.value })}
                  disabled={sxSaving || sxRunning}
                />
                <p className="jf-field__hint">
                  {t("tools.staticExport.corsHint1")} <code className="jf-code">fetch()</code>{" "}
                  {t("tools.staticExport.corsHint2")} <em>{t("tools.staticExport.originLabel")}</em>{" "}
                  {t("tools.staticExport.corsHint3")} <code className="jf-code">APP_URL</code> /{" "}
                  <code className="jf-code">STATIC_EXPORT_BASE_URL</code>{" "}
                  {t("tools.staticExport.corsHint4")}{" "}
                  <code className="jf-code">localhost</code> {t("tools.staticExport.corsHint5")}
                </p>
              </div>

              <div className="jf-grid jf-grid--3">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-sx-max">
                    {t("tools.staticExport.maxPagesLabel")}
                  </label>
                  <input
                    id="jf-sx-max"
                    className="jf-input"
                    type="number"
                    min={1}
                    max={100000}
                    value={sxSettings.maxPages}
                    onChange={(e) =>
                      setSxSettings({ ...sxSettings, maxPages: Number(e.target.value) || 1 })
                    }
                    disabled={sxSaving || sxRunning}
                  />
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-sx-conc">
                    {t("tools.staticExport.concurrencyLabel")}
                  </label>
                  <input
                    id="jf-sx-conc"
                    className="jf-input"
                    type="number"
                    min={1}
                    max={32}
                    value={sxSettings.concurrency}
                    onChange={(e) =>
                      setSxSettings({ ...sxSettings, concurrency: Number(e.target.value) || 1 })
                    }
                    disabled={sxSaving || sxRunning}
                  />
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-sx-debounce">
                    {t("tools.staticExport.autoDebounceLabel")}
                  </label>
                  <input
                    id="jf-sx-debounce"
                    className="jf-input"
                    type="number"
                    min={250}
                    max={600000}
                    value={sxSettings.debounceMs}
                    onChange={(e) =>
                      setSxSettings({ ...sxSettings, debounceMs: Number(e.target.value) || 250 })
                    }
                    disabled={sxSaving || sxRunning || !sxSettings.auto}
                  />
                </div>
              </div>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={sxSettings.auto}
                  onChange={(e) => setSxSettings({ ...sxSettings, auto: e.target.checked })}
                  disabled={sxSaving || sxRunning}
                />
                <span>
                  {t("tools.staticExport.autoRebuildCheckbox")}
                </span>
              </label>

              <div className="jf-row">
                <button
                  className="jf-btn jf-btn--primary"
                  onClick={saveSxSettings}
                  disabled={sxSaving || sxRunning}
                >
                  {sxSaving ? t("tools.staticExport.saving") : t("tools.staticExport.saveSettings")}
                </button>
                {sxSaved && !sxSaving && (
                  <span className="jf-status jf-status--saved">✓ {t("common.saved")}</span>
                )}
              </div>
            </>
          )}

          {!installationRoot && sxSettings && (
            <>
              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={sxSiteEnabled}
                  onChange={(e) => {
                    setSxSiteEnabled(e.target.checked);
                    setSxSaved(false);
                  }}
                  disabled={sxSaving || sxRunning}
                />
                <span>{t("tools.staticExport.siteEnabled")}</span>
              </label>
              <p className="jf-field__hint">{t("tools.staticExport.siteEnabledHint")}</p>
              <div className="jf-row">
                <button
                  className="jf-btn jf-btn--primary"
                  onClick={() => void saveSiteExport()}
                  disabled={sxSaving || sxRunning}
                >
                  {sxSaving ? t("tools.staticExport.saving") : t("tools.staticExport.saveSettings")}
                </button>
                {sxSaved && !sxSaving && (
                  <span className="jf-status jf-status--saved">✓ {t("common.saved")}</span>
                )}
              </div>
            </>
          )}

          <hr className="jf-divider" />

          {sxSettings && !sxSettings.enabled && (
            <p className="jf-status jf-status--error">
              {installationRoot
                ? t("tools.staticExport.exportOff")
                : t("tools.staticExport.exportOffSite")}
            </p>
          )}
          {sxSettings?.enabled && !installationRoot && !sxSiteEnabled && (
            <p className="jf-status jf-status--error">{t("tools.staticExport.siteExportOff")}</p>
          )}

          <div className="jf-row">
            <button
              className="jf-btn jf-btn--primary"
              onClick={() => runStaticExport("full")}
              disabled={sxRunning || sxSaving || sxSettings?.enabled === false || (!installationRoot && !sxSiteEnabled)}
            >
              {sxRunning ? t("tools.staticExport.exporting") : t("tools.staticExport.runFullExport")}
            </button>
            <button
              className="jf-btn jf-btn--ghost"
              onClick={() => runStaticExport("incremental")}
              disabled={
                sxRunning ||
                sxSaving ||
                !sxStatus?.hasExport ||
                sxSettings?.enabled === false ||
                (!installationRoot && !sxSiteEnabled)
              }
            >
              {t("tools.staticExport.runIncremental")}
            </button>
            <button
              className="jf-btn jf-btn--ghost"
              onClick={() => void clearStaticExport()}
              disabled={sxRunning || sxSaving || !sxStatus?.hasExport}
            >
              {t("tools.staticExport.clearExport")}
            </button>
            {sxError && <span className="jf-status jf-status--error">{sxError}</span>}
          </div>
          {installationRoot ? (
            <p className="jf-field__hint">
              <strong>{t("tools.staticExport.clearExport")}</strong>{" "}
              {t("tools.staticExport.clearExportHint1")}{" "}
              <code className="jf-code">{sxRuntimeInfo?.outDir ?? "static-export"}</code>{" "}
              {t("tools.staticExport.clearExportHint2")}
            </p>
          ) : (
            <p className="jf-field__hint">
              <strong>{t("tools.staticExport.clearExport")}</strong>{" "}
              {t("tools.staticExport.clearExportHintSite")}
            </p>
          )}

          <details>
            <summary className="jf-field__hint" style={{ cursor: "pointer" }}>
              {t("tools.staticExport.dynamicFeaturesSummary")}
            </summary>
            <p className="jf-prose" style={{ marginTop: "0.5rem" }}>
              {t("tools.staticExport.dynamicFeaturesHint1")}{" "}
              <strong>{t("tools.staticExport.formsSubmitInPlace")}</strong>{" "}
              {t("tools.staticExport.dynamicFeaturesHint2")} <code className="jf-code">fetch()</code>{" "}
              {t("tools.staticExport.dynamicFeaturesHint3")} <strong>{t("tools.staticExport.hybrid")}</strong>{" "}
              {t("tools.staticExport.dynamicFeaturesHint4")}{" "}
              <code className="jf-code">/justflows-forms/*</code>,{" "}
              <code className="jf-code">/justflows-comments/*</code>,{" "}
              <code className="jf-code">/api</code>, <code className="jf-code">/admin</code>{" "}
              {t("tools.staticExport.dynamicFeaturesHint5")}{" "}
              <strong>{t("tools.staticExport.dynamicEndpointOrigin")}</strong>{" "}
              {t("tools.staticExport.dynamicFeaturesHint6")}
            </p>
          </details>

          {sxLog.length > 0 && (
            <div className="jf-log">
              <p className="jf-log__label">{t("tools.staticExport.exportLogLabel")}</p>
              {sxLog.map((line, i) => (
                <p key={i} className={`jf-log__line${logVariant(line)}`}>
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      <SearchToolsCard />
      <ResponsiveImagesCard />
    </div>
  );
}

interface MediaSettings {
  enabled: boolean;
  responsiveMarkup: boolean;
  avif: boolean;
  widths: number[];
  maxWidth: number;
  qualityWebp: number;
  qualityAvif: number;
  qualityJpeg: number;
  stripMetadata: boolean;
  thumbnailSize: number;
  keepOriginal: string;
}

interface RegenStatus {
  running: boolean;
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  finishedAt: string | null;
  currentFile: string | null;
  errors: string[];
}

function ResponsiveImagesCard() {
  const { t } = useT();
  const enabled = useFeatureEnabled("feature" + ".responsiveImages");
  const installationRoot = useSession().session?.installationRoot === true;
  const [settings, setSettings] = useState<MediaSettings | null>(null);
  const [widthsText, setWidthsText] = useState("");
  const [envPath, setEnvPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RegenStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/media/settings");
        if (res.status === 403) {
          setError(t("tools.responsiveImages.adminOnlySettings"));
          return;
        }
        if (!res.ok) throw new Error(t("tools.responsiveImages.loadFailed"));
        const data = (await res.json()) as { settings: MediaSettings; envPath: string };
        setSettings(data.settings);
        setWidthsText(data.settings.widths.join(", "));
        setEnvPath(data.envPath);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    void refreshStatus();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  async function refreshStatus() {
    try {
      const res = await fetch("/api/media/regenerate/status");
      if (res.ok) setStatus((await res.json()) as RegenStatus);
    } catch {
      // non-fatal
    }
  }

  function startPolling() {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const res = await fetch("/api/media/regenerate/status");
        if (!res.ok) return;
        const data = (await res.json()) as RegenStatus;
        setStatus(data);
        if (!data.running) {
          if (poll.current) clearInterval(poll.current);
          poll.current = null;
          setBusy(false);
        }
      } catch {
        // keep polling
      }
    }, 1500);
  }

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    const widths = widthsText
      .split(",")
      .map((s) => Math.floor(Number(s.trim())))
      .filter((n) => Number.isFinite(n) && n >= 16 && n <= 8192);
    try {
      const res = await fetch("/api/media/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, widths: widths.length ? widths : settings.widths }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        settings?: MediaSettings;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? t("tools.responsiveImages.saveFailed"));
      if (data.settings) {
        setSettings(data.settings);
        setWidthsText(data.settings.widths.join(", "));
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function regenerate() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/media/regenerate", { method: "POST" });
      const data = (await res.json()) as RegenStatus & { error?: string };
      if (res.status === 403) throw new Error(t("tools.responsiveImages.adminOnlyRegenerate"));
      if (!res.ok && res.status !== 409)
        throw new Error(data.error ?? t("tools.responsiveImages.regenerateFailed"));
      setStatus(data);
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function upd<K extends keyof MediaSettings>(key: K, value: MediaSettings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  }

  if (!enabled) return null;
  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">{t("tools.responsiveImages.title")}</h2>
      </div>
      <div className="jf-card__body jf-stack">
        <p className="jf-prose">
          {t("tools.responsiveImages.description1")}{" "}
          <code className="jf-code">&lt;picture&gt;</code> /{" "}
          <code className="jf-code">srcset</code> {t("tools.responsiveImages.description2")}{" "}
          <code className="jf-code">width</code>/<code className="jf-code">height</code>
          {t("tools.responsiveImages.description3")}{" "}
          <code className="jf-code">docs/MEDIA.md</code>.
        </p>

        {error && <div className="jf-alert jf-alert--error">{error}</div>}

        {installationRoot && settings && (
          <>
            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => upd("enabled", e.target.checked)}
                disabled={saving}
              />
              <span>{t("tools.responsiveImages.generateOnUpload")}</span>
            </label>

            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.responsiveMarkup}
                onChange={(e) => upd("responsiveMarkup", e.target.checked)}
                disabled={saving}
              />
              <span>
                {t("tools.responsiveImages.emitMarkup1")} <code className="jf-code">&lt;picture&gt;</code> /{" "}
                <code className="jf-code">srcset</code> {t("tools.responsiveImages.emitMarkup2")}
              </span>
            </label>

            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.avif}
                onChange={(e) => upd("avif", e.target.checked)}
                disabled={saving || !settings.enabled}
              />
              <span>
                {t("tools.responsiveImages.generateAvif")}
              </span>
            </label>

            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.stripMetadata}
                onChange={(e) => upd("stripMetadata", e.target.checked)}
                disabled={saving || !settings.enabled}
              />
              <span>{t("tools.responsiveImages.stripMetadata")}</span>
            </label>

            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-img-widths">
                {t("tools.responsiveImages.variantWidthsLabel")}
              </label>
              <input
                id="jf-img-widths"
                className="jf-input"
                value={widthsText}
                onChange={(e) => setWidthsText(e.target.value)}
                placeholder="320, 640, 960, 1280, 1920"
                disabled={saving || !settings.enabled}
              />
            </div>

            <div className="jf-grid jf-grid--2">
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-img-maxw">
                  {t("tools.responsiveImages.maxWidthLabel")}
                </label>
                <input
                  id="jf-img-maxw"
                  className="jf-input"
                  type="number"
                  min={320}
                  max={8192}
                  value={settings.maxWidth}
                  onChange={(e) => upd("maxWidth", Number(e.target.value) || 2560)}
                  disabled={saving || !settings.enabled}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-img-thumb">
                  {t("tools.responsiveImages.thumbnailSizeLabel")}
                </label>
                <input
                  id="jf-img-thumb"
                  className="jf-input"
                  type="number"
                  min={0}
                  max={2048}
                  value={settings.thumbnailSize}
                  onChange={(e) => upd("thumbnailSize", Number(e.target.value) || 0)}
                  disabled={saving || !settings.enabled}
                />
              </div>
            </div>

            <div className="jf-grid jf-grid--3">
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-img-qw">
                  {t("tools.responsiveImages.webpQualityLabel")}
                </label>
                <input
                  id="jf-img-qw"
                  className="jf-input"
                  type="number"
                  min={1}
                  max={100}
                  value={settings.qualityWebp}
                  onChange={(e) => upd("qualityWebp", Number(e.target.value) || 82)}
                  disabled={saving || !settings.enabled}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-img-qa">
                  {t("tools.responsiveImages.avifQualityLabel")}
                </label>
                <input
                  id="jf-img-qa"
                  className="jf-input"
                  type="number"
                  min={1}
                  max={100}
                  value={settings.qualityAvif}
                  onChange={(e) => upd("qualityAvif", Number(e.target.value) || 50)}
                  disabled={saving || !settings.enabled || !settings.avif}
                />
              </div>
              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-img-qj">
                  {t("tools.responsiveImages.jpegQualityLabel")}
                </label>
                <input
                  id="jf-img-qj"
                  className="jf-input"
                  type="number"
                  min={1}
                  max={100}
                  value={settings.qualityJpeg}
                  onChange={(e) => upd("qualityJpeg", Number(e.target.value) || 82)}
                  disabled={saving || !settings.enabled}
                />
              </div>
            </div>

            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-img-keep">
                {t("tools.responsiveImages.keepOriginalLabel")}
              </label>
              <input
                id="jf-img-keep"
                className="jf-input"
                value={settings.keepOriginal}
                onChange={(e) => upd("keepOriginal", e.target.value)}
                placeholder="logo*, *.png"
                disabled={saving || !settings.enabled}
              />
              <p className="jf-field__hint">
                {t("tools.responsiveImages.keepOriginalHint")}
              </p>
            </div>

            {envPath && (
              <p className="jf-field__hint">
                {t("tools.responsiveImages.savedToPrefix")} <code className="jf-code">{envPath}</code>{" "}
                {t("tools.responsiveImages.savedToSuffix")} <code className="jf-code">JF_IMAGE_*</code>{" "}
                {t("tools.responsiveImages.savedToTail")}
              </p>
            )}

            <div className="jf-row">
              <button
                className="jf-btn jf-btn--primary"
                onClick={() => void saveSettings()}
                disabled={saving}
              >
                {saving ? t("common.saving") : t("tools.staticExport.saveSettings")}
              </button>
              {saved && !saving && <span className="jf-status jf-status--saved">✓ {t("common.saved")}</span>}
            </div>
          </>
        )}

        <hr className="jf-divider" />

        <h3 className="jf-card__subtitle">{t("tools.responsiveImages.regenerateHeading")}</h3>
        <p className="jf-field__hint">
          {t("tools.responsiveImages.regenerateHint")}
        </p>

        {status && (status.running || status.finishedAt) && (
          <div
            className={`jf-alert ${status.failed > 0 ? "jf-alert--error" : "jf-alert--success"}`}
          >
            {status.running ? (
              <span>
                {t("tools.responsiveImages.working", {
                  done: status.processed + status.skipped + status.failed,
                  total: status.total,
                })}
                {status.currentFile ? ` — ${status.currentFile}` : ""}
              </span>
            ) : (
              <span>
                ✓ {t("tools.responsiveImages.finished", {
                  rebuilt: status.processed,
                  skipped: status.skipped,
                  failed: status.failed,
                })}
              </span>
            )}
            {status.errors.length > 0 && (
              <ul
                style={{ margin: "0.4rem 0 0", paddingInlineStart: "1.1rem", fontSize: "0.8rem" }}
              >
                {status.errors.slice(0, 8).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="jf-row">
          <button
            className="jf-btn jf-btn--ghost"
            onClick={() => void regenerate()}
            disabled={busy || settings?.enabled === false}
          >
            {busy ? t("tools.responsiveImages.regenerating") : t("tools.responsiveImages.regenerateAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
