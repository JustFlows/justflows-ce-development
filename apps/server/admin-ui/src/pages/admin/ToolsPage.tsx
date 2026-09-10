import { SearchToolsCard } from "../../components/SearchToolsCard";
import { useEffect, useRef, useState } from "react";
import { waitForSiteRestart } from "../../lib/wait-for-restart.js";

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
}

interface StaticExportRunResponse {
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
    setPerfError("Could not load performance settings");
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
        setSxError(data.error ?? "Could not save settings");
        return;
      }
      if (data.settings) setSxSettings(data.settings);
      if (data.runtime) setSxRuntimeInfo(data.runtime);
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
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json()) as StaticExportRunResponse;
      setSxLog(data.log ?? []);
      if (!res.ok || !data.ok) {
        setSxError(data.error ?? "Export finished with errors — see the log.");
      }
      await loadSxStatus();
    } catch (e) {
      setSxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSxRunning(false);
    }
  }

  async function clearStaticExport() {
    const dir = sxRuntimeInfo?.outDir ?? "the export folder";
    if (typeof window !== "undefined" && !window.confirm(`Delete ${dir} and everything in it?`)) {
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
        setSxError(data.reason ?? "Could not clear the export.");
      } else {
        setSxLog([data.removed ? `✓ Deleted ${dir}` : "✓ Nothing to clear"]);
      }
      await loadSxStatus();
    } catch (e) {
      setSxError(e instanceof Error ? e.message : String(e));
    } finally {
      setSxRunning(false);
    }
  }

  useEffect(() => {
    void loadPerformanceSettings().finally(() => setPerfLoading(false));
    void loadPerfStats();
    void loadSxStatus();
  }, []);

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
        settings?: PerformanceSettingsResponse["settings"];
      };

      if (!res.ok) {
        throw new Error(data.error ?? "Failed to save performance settings");
      }

      if (data.settings) {
        setCache(data.settings.cache);
        setGzip(data.settings.gzip);
        setBrowserCache(data.settings.browserCache);
        if (data.settings.revalidate) setRevalidate(data.settings.revalidate);
      }
      setPerfSaved(true);
      addLog("✓ Performance settings written to .env");

      if (data.restarting) {
        setPerfSaving(false);
        setRestarting(true);
        const back = await waitForSiteRestart(addLog);
        if (!back) setRestartFailed(true);
        setRestarting(false);
      } else if (data.restartRequired) {
        setRestartFailed(true);
        addLog("⚠ Could not auto-restart — restart manually in Plesk → Node.js");
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
        addLog(`✓ Object cache cleared${data.enabled === false ? " (caching is disabled)" : ""}`);
        await loadPerfStats();
        return;
      }
      throw new Error("Failed to clear cache");
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
          <h1>Tools</h1>
          <p>Import, export, and site utilities</p>
        </div>
      </header>

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Performance suite</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            Object cache, GZIP compression, and browser cache headers for faster public pages.
            Responses include <code className="jf-code">X-Jf-Cache</code>,{" "}
            <code className="jf-code">X-Jf-Page-Cache</code>,{" "}
            <code className="jf-code">Content-Encoding</code>, and{" "}
            <code className="jf-code">Cache-Control</code> when active.
          </p>

          {!perfLoading && perfStats && (
            <div className="jf-stack" style={{ gap: "0.75rem" }}>
              <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <span className={`jf-badge jf-badge--${perfStats.enabled ? "ok" : "warn"}`}>
                  Object cache {perfStats.enabled ? "on" : "off"}
                </span>
                <span className={`jf-badge jf-badge--${perfStats.gzip.enabled ? "ok" : "warn"}`}>
                  GZIP {perfStats.gzip.enabled ? "on" : "off"}
                </span>
                <span
                  className={`jf-badge jf-badge--${perfStats.browserCache.enabled ? "ok" : "warn"}`}
                >
                  Browser cache {perfStats.browserCache.enabled ? "on" : "off"}
                </span>
                {perfStats.revalidate && (
                  <span
                    className={`jf-badge jf-badge--${perfStats.revalidate.enabled ? "ok" : "warn"}`}
                  >
                    Revalidate {perfStats.revalidate.enabled ? "on" : "off"}
                  </span>
                )}
                <span className="jf-badge jf-badge--info">
                  {perfStats.stats.hits} hits / {perfStats.stats.misses} misses
                  {perfStats.stats.hitRate !== null ? ` (${perfStats.stats.hitRate}%)` : ""}
                </span>
                <span className="jf-badge jf-badge--info">
                  {perfStats.storage.keyCount} keys · {formatBytes(perfStats.storage.totalBytes)}
                </span>
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost"
                  onClick={() => loadPerfStats()}
                  disabled={statsLoading}
                >
                  {statsLoading ? "Refreshing…" : "↻ Refresh stats"}
                </button>
              </div>
              {perfStats.storage.sampleKeys.length > 0 && (
                <details>
                  <summary className="jf-field__hint" style={{ cursor: "pointer" }}>
                    Sample cache files ({perfStats.storage.sampleKeys.length})
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

              <h3 className="jf-card__subtitle">Object cache (jf-cache)</h3>
              <p className="jf-field__hint">
                Read-through cache for content, menus, theme data, and full HTML pages.
              </p>

              <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                <span className={`jf-badge jf-badge--${cache.enabled ? "ok" : "warn"}`}>
                  {cache.enabled ? "Enabled" : "Disabled"}
                </span>
                <span className="jf-badge jf-badge--info">{cache.driver}</span>
                {runtime !== null && runtime.active !== cache.enabled && (
                  <span className="jf-badge jf-badge--warn">Restart required to apply</span>
                )}
              </div>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={cache.enabled}
                  onChange={(e) => setCache((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>Enable object cache</span>
              </label>

              <div className="jf-grid jf-grid--2">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-cache-driver">
                    Driver
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
                    <option value="filesystem">Filesystem (default, survives restarts)</option>
                    <option value="memory">Memory (per process, fastest)</option>
                  </select>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-cache-ttl">
                    TTL (seconds)
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
                    Cache directory
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

              <h3 className="jf-card__subtitle">Revalidate on update</h3>
              <p className="jf-field__hint">
                When content, menus, theme, or settings change, clear the selected cache layers
                immediately. Turn off to rely on TTL only. Fires the{" "}
                <code className="jf-code">cache.revalidated</code> hook for plugins.
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={revalidate.enabled}
                  onChange={(e) => setRevalidate((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>Revalidate selected objects when data changes</span>
              </label>

              <div
                className="jf-grid jf-grid--2"
                style={{ opacity: revalidate.enabled ? 1 : 0.55 }}
              >
                {(
                  [
                    ["pages", "Full HTML pages"],
                    ["content", "Content entries (posts / pages)"],
                    ["menus", "Menus"],
                    ["theme", "Theme customizations"],
                    ["cssProviders", "CSS providers"],
                    ["site", "Site context"],
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

              <h3 className="jf-card__subtitle">GZIP compression</h3>
              <p className="jf-field__hint">
                Compresses HTML, JSON, CSS, and JavaScript when the browser accepts gzip.
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={gzip.enabled}
                  onChange={(e) => setGzip((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>Enable GZIP compression</span>
              </label>

              <div className="jf-grid jf-grid--2">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-gzip-level">
                    Compression level
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
                  <p className="jf-field__hint">1 = fastest, 9 = smallest (default 6).</p>
                </div>
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-gzip-min">
                    Minimum size (bytes)
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
                  <p className="jf-field__hint">Skip compression for tiny responses.</p>
                </div>
              </div>

              <hr className="jf-divider" />

              <h3 className="jf-card__subtitle">Browser cache</h3>
              <p className="jf-field__hint">
                Sets <code className="jf-code">Cache-Control</code> on public HTML and static files.
                Admin and API routes always get <code className="jf-code">no-store</code>.
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={browserCache.enabled}
                  onChange={(e) => setBrowserCache((s) => ({ ...s, enabled: e.target.checked }))}
                  disabled={perfBusy}
                />
                <span>Enable browser cache headers</span>
              </label>

              <div className="jf-grid jf-grid--3">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-bc-html">
                    HTML max-age (s)
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
                    Static max-age (s)
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
                    Stale-while-revalidate (s)
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
                  Config file: <code className="jf-code">{envPath}</code>
                </p>
              )}

              <div className="jf-row">
                <button
                  className="jf-btn jf-btn--primary"
                  onClick={savePerformanceSettings}
                  disabled={perfBusy || cacheClearing}
                >
                  {perfSaving ? "Saving…" : restarting ? "Restarting…" : "Save all & restart app"}
                </button>
                <button
                  className="jf-btn jf-btn--ghost"
                  onClick={clearCache}
                  disabled={perfBusy || cacheClearing}
                >
                  {cacheClearing ? "Clearing…" : "Clear object cache"}
                </button>
                {perfSaved && !perfBusy && (
                  <span className="jf-status jf-status--saved">✓ Saved</span>
                )}
                {perfError && <span className="jf-status jf-status--error">{perfError}</span>}
              </div>

              {restartFailed && (
                <div className="jf-banner jf-banner--warn">
                  <span className="jf-banner__icon" aria-hidden="true">
                    ⚠️
                  </span>
                  <div>
                    <div className="jf-banner__title">Manual restart needed</div>
                    <div className="jf-banner__sub">
                      Go to Plesk → Node.js → Restart App, then refresh this page.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {log.length > 0 && (
        <div className="jf-log">
          <p className="jf-log__label">Performance log</p>
          {log.map((line, i) => (
            <p key={i} className={`jf-log__line${logVariant(line)}`}>
              {line}
            </p>
          ))}
        </div>
      )}

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Import from WordPress</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            Upload a WordPress export file (.xml from Tools → Export in the WordPress admin) to
            bring your posts and pages across.
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
              {importing ? "Importing…" : "Upload WordPress .xml"}
            </button>
          </div>

          {result &&
            (result.ok ? (
              <div className="jf-alert jf-alert--success">
                <div>
                  <strong>✓ Import complete</strong>
                  <ul style={{ margin: "0.4rem 0 0", paddingInlineStart: "1.1rem" }}>
                    <li>Posts imported: {result.imported?.posts}</li>
                    <li>Pages imported: {result.imported?.pages}</li>
                    <li>Skipped: {result.imported?.skipped}</li>
                  </ul>
                  {result.errors && result.errors.length > 0 && (
                    <p style={{ margin: "0.4rem 0 0" }}>
                      {result.errors.length} item(s) had errors. Check the server logs.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="jf-alert jf-alert--error" role="alert">
                <strong>Import failed:</strong>&nbsp;{result.error}
              </div>
            ))}
        </div>
      </div>

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Static site export</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            Write every published page plus its assets, <code className="jf-code">sitemap.xml</code>
            , <code className="jf-code">robots.txt</code> and{" "}
            <code className="jf-code">theme.css</code> to a folder you can serve from object storage
            or a CDN — no Node origin needed for those pages. See{" "}
            <code className="jf-code">docs/STATIC-EXPORT.md</code> for deployment and rebuild
            details.
          </p>

          <div className="jf-row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <span className={`jf-badge jf-badge--${sxRuntimeInfo?.autoArmed ? "ok" : "warn"}`}>
              Auto-rebuild{" "}
              {sxRuntimeInfo?.autoArmed ? "armed" : sxSettings?.auto ? "on (idle)" : "off"}
            </span>
            {sxSettings?.auto && sxRuntimeInfo && !sxRuntimeInfo.revalidateEnabled && (
              <span className="jf-badge jf-badge--warn">Needs CACHE_REVALIDATE_ENABLED=1</span>
            )}
            {sxStatus?.lastRun ? (
              <>
                <span className="jf-badge jf-badge--info">
                  Last: {new Date(sxStatus.lastRun.generatedAt).toLocaleString()} (
                  {sxStatus.lastRun.mode})
                </span>
                <span className="jf-badge jf-badge--info">
                  {sxStatus.lastRun.pages} pages · {sxStatus.lastRun.assets} assets
                </span>
              </>
            ) : (
              <span className="jf-badge jf-badge--warn">Never run</span>
            )}
          </div>

          {sxSettings && (
            <>
              <h3 className="jf-card__subtitle">Configuration</h3>
              <p className="jf-field__hint">
                Saved to <code className="jf-code">{sxEnvPath || ".env"}</code> as{" "}
                <code className="jf-code">STATIC_EXPORT_*</code> and applied immediately — no
                restart.
              </p>

              <label className="jf-checkrow">
                <input
                  type="checkbox"
                  checked={sxSettings.enabled}
                  onChange={(e) => setSxSettings({ ...sxSettings, enabled: e.target.checked })}
                  disabled={sxSaving || sxRunning}
                />
                <span>
                  Static export enabled — when off, the Run actions and auto-rebuild are refused
                  (files already on disk are left alone; use <strong>Clear export</strong> to remove
                  them).
                </span>
              </label>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-dir">
                  Output directory
                </label>
                <input
                  id="jf-sx-dir"
                  className="jf-input"
                  value={sxSettings.dir}
                  placeholder="./static-export"
                  onChange={(e) => setSxSettings({ ...sxSettings, dir: e.target.value })}
                  disabled={sxSaving || sxRunning}
                />
                <p className="jf-field__hint">
                  Relative paths resolve from the install root. Resolves to{" "}
                  <code className="jf-code">{sxRuntimeInfo?.outDir}</code>.
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-base">
                  Public base URL
                </label>
                <input
                  id="jf-sx-base"
                  className="jf-input"
                  value={sxSettings.baseUrl}
                  placeholder="https://www.example.com — defaults to APP_URL"
                  onChange={(e) => setSxSettings({ ...sxSettings, baseUrl: e.target.value })}
                  disabled={sxSaving || sxRunning}
                />
                <p className="jf-field__hint">
                  Recorded in the manifest and used to detect same-origin links while crawling.
                  Canonical tags and <code className="jf-code">sitemap.xml</code> URLs are rendered
                  from <code className="jf-code">APP_URL</code> — set that to your public origin for
                  a production export.
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-crawl">
                  Crawl URL
                </label>
                <div className="jf-row" style={{ gap: "0.5rem", alignItems: "stretch" }}>
                  <input
                    id="jf-sx-crawl"
                    className="jf-input"
                    style={{ flex: 1 }}
                    value={sxSettings.crawlUrl}
                    placeholder="https://www.example.com — blank crawls this server directly"
                    onChange={(e) => setSxSettings({ ...sxSettings, crawlUrl: e.target.value })}
                    disabled={sxSaving || sxRunning}
                  />
                  <button
                    type="button"
                    className="jf-btn jf-btn--ghost"
                    onClick={() => setSxSettings({ ...sxSettings, crawlUrl: suggestedOrigin })}
                    disabled={sxSaving || sxRunning || !suggestedOrigin}
                  >
                    Use this site
                  </button>
                  {sxSettings.crawlUrl && (
                    <button
                      type="button"
                      className="jf-btn jf-btn--ghost"
                      onClick={() => setSxSettings({ ...sxSettings, crawlUrl: "" })}
                      disabled={sxSaving || sxRunning}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="jf-field__hint">
                  Where the crawler fetches pages from. Leave blank to read this server directly
                  (loopback in development, <code className="jf-code">APP_URL</code> on production).
                  Set it to your public domain when the app runs behind Passenger / Plesk, where a
                  loopback port is not reachable — the crawl still carries the export header, so it
                  bypasses analytics and preview toolbars.
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-origin">
                  Dynamic-endpoint origin
                </label>
                <div className="jf-row" style={{ gap: "0.5rem", alignItems: "stretch" }}>
                  <input
                    id="jf-sx-origin"
                    className="jf-input"
                    style={{ flex: 1 }}
                    value={sxSettings.originUrl}
                    placeholder="https://app.example.com — leave blank for a hybrid proxy"
                    onChange={(e) => setSxSettings({ ...sxSettings, originUrl: e.target.value })}
                    disabled={sxSaving || sxRunning}
                  />
                  <button
                    type="button"
                    className="jf-btn jf-btn--ghost"
                    onClick={() => setSxSettings({ ...sxSettings, originUrl: suggestedOrigin })}
                    disabled={sxSaving || sxRunning || !suggestedOrigin}
                  >
                    Use this site
                  </button>
                  {sxSettings.originUrl && (
                    <button
                      type="button"
                      className="jf-btn jf-btn--ghost"
                      onClick={() => setSxSettings({ ...sxSettings, originUrl: "" })}
                      disabled={sxSaving || sxRunning}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="jf-field__hint">
                  When set, <code className="jf-code">&lt;form&gt;</code> actions for form and
                  comment submission are rewritten to absolute URLs against this origin. The
                  exported pages then submit forms by <code className="jf-code">fetch()</code> and
                  show the confirmation in place — no navigation. <strong>Use this site</strong>{" "}
                  fills it with{" "}
                  <code className="jf-code">{suggestedOrigin || "this site's origin"}</code>. Leave
                  blank if the CDN proxies <code className="jf-code">/justflows-forms/*</code> and{" "}
                  <code className="jf-code">/justflows-comments/*</code> to the origin (hybrid) —
                  same result, no CORS.
                </p>
              </div>

              <div className="jf-field">
                <label className="jf-field__label" htmlFor="jf-sx-cors">
                  Allowed static origins (CORS)
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
                  Comma-separated origins allowed to cross-origin{" "}
                  <code className="jf-code">fetch()</code> the submit endpoints. Only needed with a{" "}
                  <em>Dynamic-endpoint origin</em> set. <code className="jf-code">APP_URL</code> /{" "}
                  <code className="jf-code">STATIC_EXPORT_BASE_URL</code> and, outside production,
                  any <code className="jf-code">localhost</code> port are always allowed — so local
                  testing needs nothing here.
                </p>
              </div>

              <div className="jf-grid jf-grid--3">
                <div className="jf-field">
                  <label className="jf-field__label" htmlFor="jf-sx-max">
                    Max pages
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
                    Concurrency
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
                    Auto debounce (ms)
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
                  Rebuild automatically after publish, unpublish, delete, menu, theme, or settings
                  changes
                </span>
              </label>

              <div className="jf-row">
                <button
                  className="jf-btn jf-btn--primary"
                  onClick={saveSxSettings}
                  disabled={sxSaving || sxRunning}
                >
                  {sxSaving ? "Saving…" : "Save settings"}
                </button>
                {sxSaved && !sxSaving && (
                  <span className="jf-status jf-status--saved">✓ Saved</span>
                )}
              </div>
            </>
          )}

          <hr className="jf-divider" />

          {sxSettings && !sxSettings.enabled && (
            <p className="jf-status jf-status--error">
              Static export is off. Enable it in Configuration and Save to run.
            </p>
          )}

          <div className="jf-row">
            <button
              className="jf-btn jf-btn--primary"
              onClick={() => runStaticExport("full")}
              disabled={sxRunning || sxSaving || sxSettings?.enabled === false}
            >
              {sxRunning ? "Exporting…" : "Run full export"}
            </button>
            <button
              className="jf-btn jf-btn--ghost"
              onClick={() => runStaticExport("incremental")}
              disabled={
                sxRunning || sxSaving || !sxStatus?.hasExport || sxSettings?.enabled === false
              }
            >
              Run incremental
            </button>
            <button
              className="jf-btn jf-btn--ghost"
              onClick={() => void clearStaticExport()}
              disabled={sxRunning || sxSaving || !sxStatus?.hasExport}
            >
              Clear export
            </button>
            {sxError && <span className="jf-status jf-status--error">{sxError}</span>}
          </div>
          <p className="jf-field__hint">
            <strong>Clear export</strong> deletes the whole{" "}
            <code className="jf-code">{sxRuntimeInfo?.outDir ?? "static-export"}</code> folder.
            Disabling auto-rebuild does not remove any files.
          </p>

          <details>
            <summary className="jf-field__hint" style={{ cursor: "pointer" }}>
              Dynamic features (forms, preview, comments, search)
            </summary>
            <p className="jf-prose" style={{ marginTop: "0.5rem" }}>
              Preview URLs are never exported. Client scripts (menus, animations, language switch
              UI) are downloaded and work offline. <strong>Forms submit in place</strong> via{" "}
              <code className="jf-code">fetch()</code> and show the confirmation without leaving the
              page — as long as the submit endpoint is reachable: a <strong>hybrid</strong> deploy
              (CDN proxies <code className="jf-code">/justflows-forms/*</code>,{" "}
              <code className="jf-code">/justflows-comments/*</code>,{" "}
              <code className="jf-code">/api</code>, <code className="jf-code">/admin</code> to the
              origin) or a <strong>Dynamic-endpoint origin</strong> set above. Comment posting,
              login/registration and search still need the origin. Client analytics (Google Tag)
              works; the server-side pageview counter does not.
            </p>
          </details>

          {sxLog.length > 0 && (
            <div className="jf-log">
              <p className="jf-log__label">Export log</p>
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
          setError("Only administrators can change responsive-image settings.");
          return;
        }
        if (!res.ok) throw new Error("Could not load responsive-image settings");
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
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Could not save settings");
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
      if (res.status === 403) throw new Error("Only administrators can regenerate the library");
      if (!res.ok && res.status !== 409)
        throw new Error(data.error ?? "Could not start regeneration");
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

  return (
    <div className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">Responsive images</h2>
      </div>
      <div className="jf-card__body jf-stack">
        <p className="jf-prose">
          Every uploaded photo gets resized variants plus modern formats (WebP, and AVIF when
          enabled). Image blocks and themes emit <code className="jf-code">&lt;picture&gt;</code> /{" "}
          <code className="jf-code">srcset</code> with intrinsic{" "}
          <code className="jf-code">width</code>/<code className="jf-code">height</code>, lazy
          loading, and a focal point set in the Media Library. SVGs are never rasterised. See{" "}
          <code className="jf-code">docs/MEDIA.md</code>.
        </p>

        {error && <div className="jf-alert jf-alert--error">{error}</div>}

        {settings && (
          <>
            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => upd("enabled", e.target.checked)}
                disabled={saving}
              />
              <span>Generate responsive variants on upload</span>
            </label>

            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.responsiveMarkup}
                onChange={(e) => upd("responsiveMarkup", e.target.checked)}
                disabled={saving}
              />
              <span>
                Emit <code className="jf-code">&lt;picture&gt;</code> /{" "}
                <code className="jf-code">srcset</code> on the public site — image blocks,
                galleries, blog lists, and theme templates. Turn off to serve the original
                everywhere (generated files are kept).
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
                Also generate AVIF (smaller files, noticeably slower to encode — off by default)
              </span>
            </label>

            <label className="jf-checkrow">
              <input
                type="checkbox"
                checked={settings.stripMetadata}
                onChange={(e) => upd("stripMetadata", e.target.checked)}
                disabled={saving || !settings.enabled}
              />
              <span>Strip EXIF/GPS metadata from generated variants</span>
            </label>

            <div className="jf-field">
              <label className="jf-field__label" htmlFor="jf-img-widths">
                Variant widths (px, comma-separated)
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
                  Max width (px)
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
                  Thumbnail size (px, 0 = off)
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
                  WebP quality
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
                  AVIF quality
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
                  JPEG quality
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
                Keep original only (filename globs, comma-separated)
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
                Matching uploads are stored untouched — logos, transparency edge cases, pixel art.
              </p>
            </div>

            {envPath && (
              <p className="jf-field__hint">
                Saved to <code className="jf-code">{envPath}</code> as{" "}
                <code className="jf-code">JF_IMAGE_*</code> — applied immediately, no restart.
              </p>
            )}

            <div className="jf-row">
              <button
                className="jf-btn jf-btn--primary"
                onClick={() => void saveSettings()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save settings"}
              </button>
              {saved && !saving && <span className="jf-status jf-status--saved">✓ Saved</span>}
            </div>
          </>
        )}

        <hr className="jf-divider" />

        <h3 className="jf-card__subtitle">Regenerate</h3>
        <p className="jf-field__hint">
          Rebuild every image’s variant set with the current settings — run this after changing
          widths, formats, or quality. New uploads are processed automatically.
        </p>

        {status && (status.running || status.finishedAt) && (
          <div
            className={`jf-alert ${status.failed > 0 ? "jf-alert--error" : "jf-alert--success"}`}
          >
            {status.running ? (
              <span>
                Working… {status.processed + status.skipped + status.failed}/{status.total}
                {status.currentFile ? ` — ${status.currentFile}` : ""}
              </span>
            ) : (
              <span>
                ✓ Finished: {status.processed} rebuilt, {status.skipped} skipped, {status.failed}{" "}
                failed.
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
            {busy ? "Regenerating…" : "Regenerate all images"}
          </button>
        </div>
      </div>
    </div>
  );
}
