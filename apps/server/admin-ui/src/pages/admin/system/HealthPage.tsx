import StorageUsageCard, { type StorageUsage } from "../../../components/StorageUsageCard";
import { useEffect, useState } from "react";
import { useT } from "../../../i18n/I18nProvider";

interface DiagnosticsReport {
  storage?: StorageUsage;
  generatedAt: string;
  runtime: { justflowsVersion: string; nodeVersion: string; mode: string; uptimeSeconds: number; memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; systemUsedBytes: number; systemTotalBytes: number }; debug: { enabled: boolean; expiresAt?: string | null }; warnings: string[] };
  database: { driver: string; connected: boolean; latencyMs: number; migrations: { applied: number; current: boolean; pending: string[] } };
  cache: { enabled: boolean; stats: { hits: number; misses: number; hitRate: number | null } };
  extensions: {
    plugins: Array<{ id: string; name: string; version: string; source: "development" | "marketplace" | "database"; status: string; registered: boolean; onDisk: boolean; permissions: string[]; path: string | null }>;
    themes: Array<{ id: string; name: string; version: string; source: "development" | "marketplace" | "database"; status: string; registered: boolean; onDisk: boolean; permissions: string[]; path: string | null }>;
  };
  hooks: { totals: { handlers: number; runs: number; errors: number; disabled: number }; handlers: Array<{ hook: string; pluginId: string | null; priority: number; runs: number; errors: number; totalMs: number; disabled: boolean }> };
  jobs: { running: boolean; items: Array<{ name: string; schedule?: string; attempts: number; maxAttempts: number; status: "pending" | "running" | "failed" | "done"; lastResult?: { success: boolean; message?: string } }> };
  pluginChecks: Array<{ pluginId: string; id: string; label: string; result: { status: "ok" | "warning" | "error"; summary: string } }>;
  errors: Array<{ id: string; timestamp: string; requestId: string | null; context: string; message: string }>;
  traces: Array<{ requestId: string; timestamp: string; path: string; durationMs: number; pageCache: string; objectCache: string; databaseQueries: number; databaseMs: number; hookRuns: number; hookErrors: number; theme: string; template: string }>;
}

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

export default function HealthPage() {
  const { t } = useT();
  const requestedTraceId = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("requestId") ?? "";
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bundleBusy, setBundleBusy] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState("");
  const [cliCopied, setCliCopied] = useState(false);

  const cliCommands = "justflows status\njustflows health\njustflows cache clear\njustflows db migrate";

  async function copyCliCommands() {
    try {
      await navigator.clipboard.writeText(cliCommands);
      setCliCopied(true);
      setTimeout(() => setCliCopied(false), 2000);
    } catch {
      setError(t("health.clipboard.copyError"));
    }
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/diagnostics");
      const data = await res.json() as DiagnosticsReport & { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("health.errors.diagnosticsUnavailable"));
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function downloadBundle() {
    if (!window.confirm(t("health.bundle.confirmMessage"))) return;
    setBundleBusy(true);
    setError("");
    try {
      const res = await fetch("/api/diagnostics/bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? t("health.bundle.generationFailed"));
      }
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `justflows-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBundleBusy(false);
    }
  }

  async function setDebugMode(enabled: boolean) {
    setDebugBusy(true);
    setError("");
    try {
      const res = await fetch("/api/diagnostics/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, expiresInHours: 4 }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? t("health.debug.updateFailed"));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDebugBusy(false);
    }
  }

  async function runTest(action: "database" | "cache" | "jobs" | "email" | "storage") {
    setTestBusy(action); setTestResult(""); setError("");
    try {
      const res = await fetch("/api/diagnostics/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await res.json() as { error?: string; latencyMs?: number };
      if (!res.ok) throw new Error(data.error ?? t("health.test.testFailed"));
      const actionLabel = `${action[0]!.toUpperCase()}${action.slice(1)}`;
      setTestResult(t("health.test.checkPassed", { action: actionLabel, latencyMs: data.latencyMs ?? 0 })); await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setTestBusy(null); }
  }

  async function retryJob(name: string) {
    const res = await fetch(`/api/diagnostics/jobs/${encodeURIComponent(name)}/retry`, { method: "POST" });
    const data = await res.json() as { error?: string };
    if (!res.ok) { setError(data.error ?? t("health.jobs.retryFailed")); return; }
    await load();
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>{t("health.header.title")}</h1>
          <p>{t("health.header.subtitle")}</p>
        </div>
        <div className="jf-pagehead__actions">
          <button type="button" className="jf-btn jf-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? t("health.header.refreshing") : t("health.header.refresh")}
          </button>
          <button type="button" className="jf-btn jf-btn--primary" onClick={() => void downloadBundle()} disabled={!report || bundleBusy}>
            {bundleBusy ? t("health.header.preparingBundle") : t("health.header.downloadBundle")}
          </button>
        </div>
      </header>

      {error && <div className="jf-alert jf-alert--error" role="alert">{error}</div>}
      {report && <StorageUsageCard usage={report.storage} refreshKey={report.generatedAt} endpoint="/api/diagnostics/storage" />}
      {report?.runtime.warnings.map((warning) => (
        <div className="jf-banner jf-banner--warn" role="alert" key={warning}>
          <span className="jf-banner__icon" aria-hidden="true">⚠</span>
          <div><div className="jf-banner__title">{t("health.debug.warningTitle")}</div><div className="jf-banner__sub">{warning}</div></div>
        </div>
      ))}

      {loading && !report && <div className="jf-card"><div className="jf-card__body"><div className="jf-skeleton" style={{ height: 320 }} /></div></div>}

      {report && <>
        {(() => {
          const heapPercent = Math.round((report.runtime.memory.heapUsedBytes / Math.max(1, report.runtime.memory.heapTotalBytes)) * 100);
          const systemPercent = Math.round((report.runtime.memory.systemUsedBytes / Math.max(1, report.runtime.memory.systemTotalBytes)) * 100);
          const pluginErrors = report.pluginChecks.filter((check) => check.result.status === "error");
          const hasIssues = !report.database.connected || !report.database.migrations.current || report.hooks.totals.errors > 0 || report.errors.length > 0 || pluginErrors.length > 0;
          const dbStatus = report.database.connected ? t("health.overview.connected") : t("health.overview.unavailable");
          const migrationsStatus = report.database.migrations.current ? t("health.overview.migrationsCurrent") : t("health.overview.migrationsPending");
          return <>
            <div className={`jf-banner jf-banner--${hasIssues ? "warn" : "ok"}`}>
              <span className="jf-banner__icon" aria-hidden="true">{hasIssues ? "⚠" : "✓"}</span>
              <div>
                <div className="jf-banner__title">{hasIssues ? t("health.overview.issuesFound") : t("health.overview.allHealthy")}</div>
                <div className="jf-banner__sub">{t("health.overview.statusLine", { dbStatus, migrationsStatus, errorCount: report.errors.length })}</div>
                {pluginErrors.map((check) => (
                  <div className="jf-banner__sub" key={`${check.pluginId}/${check.id}`}>{check.label}: {check.result.summary}</div>
                ))}
              </div>
            </div>

            <div className="jf-diagnostics-overview">
              <div className="jf-diagnostic-stat"><span className="jf-diagnostic-stat__label">{t("health.overview.processHeap")}</span><strong>{formatBytes(report.runtime.memory.heapUsedBytes)}</strong><span>{t("health.overview.percentOf", { percent: heapPercent, total: formatBytes(report.runtime.memory.heapTotalBytes) })}</span><div className="jf-meter" role="meter" aria-label={t("health.overview.ariaHeapUsage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={heapPercent}><span style={{ width: `${Math.min(100, heapPercent)}%` }} /></div></div>
              <div className="jf-diagnostic-stat"><span className="jf-diagnostic-stat__label">{t("health.overview.systemMemory")}</span><strong>{formatBytes(report.runtime.memory.systemUsedBytes)}</strong><span>{t("health.overview.percentOf", { percent: systemPercent, total: formatBytes(report.runtime.memory.systemTotalBytes) })}</span><div className="jf-meter" role="meter" aria-label={t("health.overview.ariaSystemMemory")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={systemPercent}><span style={{ width: `${Math.min(100, systemPercent)}%` }} /></div></div>
              <div className="jf-diagnostic-stat"><span className="jf-diagnostic-stat__label">{t("health.overview.cacheHitRate")}</span><strong>{report.cache.stats.hitRate === null ? "—" : `${report.cache.stats.hitRate}%`}</strong><span>{t("health.overview.requestsObserved", { count: report.cache.stats.hits + report.cache.stats.misses })}</span><div className="jf-meter" role="meter" aria-label={t("health.overview.cacheHitRate")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={report.cache.stats.hitRate ?? 0}><span style={{ width: `${report.cache.stats.hitRate ?? 0}%` }} /></div></div>
              <div className="jf-diagnostic-stat"><span className="jf-diagnostic-stat__label">{t("health.overview.databaseLatency")}</span><strong>{t("health.units.milliseconds", { value: report.database.latencyMs })}</strong><span>{t("health.overview.driverConnected", { driver: report.database.driver })}</span><span className={`jf-badge jf-badge--${report.database.latencyMs > 250 ? "warn" : "ok"}`}>{report.database.latencyMs > 250 ? t("health.overview.slow") : t("health.overview.responsive")}</span></div>
            </div>
          </>;
        })()}

        <div className="jf-grid jf-grid--2">
          <section className="jf-card">
            <div className="jf-card__head"><h2 className="jf-card__title">{t("health.runtime.title")}</h2><span className={`jf-badge jf-badge--${report.runtime.debug.enabled ? "warn" : "ok"}`}>{report.runtime.debug.enabled ? t("health.runtime.debugOn") : t("health.runtime.debugOff")}</span></div>
            <div className="jf-card__body"><dl className="jf-diagnostics-list">
              <div><dt>Justflows</dt><dd>{report.runtime.justflowsVersion}</dd></div>
              <div><dt>Node.js</dt><dd>{report.runtime.nodeVersion}</dd></div>
              <div><dt>{t("health.runtime.mode")}</dt><dd>{report.runtime.mode}</dd></div>
              <div><dt>{t("health.runtime.uptime")}</dt><dd>{formatUptime(report.runtime.uptimeSeconds)}</dd></div>
              <div><dt>{t("health.runtime.memory")}</dt><dd>{t("health.runtime.memoryUsage", { heap: formatBytes(report.runtime.memory.heapUsedBytes), rss: formatBytes(report.runtime.memory.rssBytes) })}</dd></div>
            </dl></div>
          </section>

          <section className="jf-card">
            <div className="jf-card__head"><h2 className="jf-card__title">{t("health.services.title")}</h2></div>
            <div className="jf-card__body"><dl className="jf-diagnostics-list">
              <div><dt>{t("health.services.database")}</dt><dd><span className={`jf-badge jf-badge--${report.database.connected ? "ok" : "error"}`}>{report.database.driver}</span></dd></div>
              <div><dt>{t("health.services.latency")}</dt><dd>{t("health.units.milliseconds", { value: report.database.latencyMs })}</dd></div>
              <div><dt>{t("health.services.migrations")}</dt><dd><span className={`jf-badge jf-badge--${report.database.migrations.current ? "ok" : "warn"}`}>{report.database.migrations.current ? t("health.services.current") : t("health.services.pendingCount", { count: report.database.migrations.pending.length })}</span></dd></div>
              <div><dt>{t("health.services.objectCache")}</dt><dd><span className={`jf-badge jf-badge--${report.cache.enabled ? "ok" : "warn"}`}>{report.cache.enabled ? t("health.services.enabled") : t("health.services.disabled")}</span></dd></div>
              <div><dt>{t("health.services.cacheActivity")}</dt><dd>{t("health.services.cacheActivityBase", { hits: report.cache.stats.hits, misses: report.cache.stats.misses })}{report.cache.stats.hitRate === null ? "" : t("health.services.cacheHitRateSuffix", { hitRate: report.cache.stats.hitRate })}</dd></div>
            </dl></div>
          </section>
        </div>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.debug.title")}</h2><p className="jf-field__hint">{t("health.debug.hint")}</p></div><span className={`jf-badge jf-badge--${report.runtime.debug.enabled ? "warn" : "ok"}`}>{report.runtime.debug.enabled ? t("health.debug.active") : t("health.debug.offStatus")}</span></div>
          <div className="jf-card__body jf-stack">
            <p className="jf-prose">{t("health.debug.description")}</p>
            {report.runtime.debug.enabled && report.runtime.debug.expiresAt && <p className="jf-field__hint">{t("health.debug.autoExpiry", { date: new Date(report.runtime.debug.expiresAt).toLocaleString() })}</p>}
            <div className="jf-row">
              <button type="button" className={`jf-btn ${report.runtime.debug.enabled ? "jf-btn--danger" : "jf-btn--primary"}`} onClick={() => void setDebugMode(!report.runtime.debug.enabled)} disabled={debugBusy}>{debugBusy ? t("health.debug.updating") : report.runtime.debug.enabled ? t("health.debug.disable") : t("health.debug.enable")}</button>
              <span className="jf-field__hint">{t("health.debug.manualConfigPrefix")} <code className="jf-code">JF_DEBUG=true</code> {t("health.debug.manualConfigAnd")} <code className="jf-code">JF_DEBUG_EXPIRES_AT</code> {t("health.debug.manualConfigIn")} <code className="jf-code">.env</code>.</span>
            </div>
          </div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.test.title")}</h2><p className="jf-field__hint">{t("health.test.hint")}</p></div></div>
          <div className="jf-card__body jf-stack"><div className="jf-row">{(["database", "cache", "jobs", "email", "storage"] as const).map((action) => <button key={action} type="button" className="jf-btn jf-btn--ghost" disabled={testBusy !== null} onClick={() => void runTest(action)}>{testBusy === action ? t("health.test.testing") : t("health.test.testButton", { action })}</button>)}</div>{testResult && <div className="jf-alert jf-alert--success" role="status">{testResult}</div>}</div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.jobs.title")}</h2><p className="jf-field__hint">{t("health.jobs.hint")}</p></div><span className={`jf-badge jf-badge--${report.jobs.running ? "ok" : "warn"}`}>{report.jobs.running ? t("health.jobs.running") : t("health.jobs.stopped")}</span></div>
          <div className="jf-card__body jf-card__body--flush">{report.jobs.items.length === 0 ? <div className="jf-empty"><p>{t("health.jobs.noJobs")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.jobs.colJob")}</th><th>{t("health.jobs.colStatus")}</th><th>{t("health.jobs.colSchedule")}</th><th>{t("health.jobs.colAttempts")}</th><th>{t("health.jobs.colLastResult")}</th><th /></tr></thead><tbody>{report.jobs.items.map((job) => <tr key={job.name}><td className="jf-td--mono">{job.name}</td><td>{job.status}</td><td>{job.schedule ?? t("health.jobs.onDemand")}</td><td>{job.attempts}/{job.maxAttempts}</td><td>{job.lastResult?.message ?? (job.lastResult?.success ? t("health.jobs.completed") : "—")}</td><td>{job.status === "failed" && <button type="button" className="jf-btn jf-btn--ghost" onClick={() => void retryJob(job.name)}>{t("health.jobs.retry")}</button>}</td></tr>)}</tbody></table></div>}</div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.pluginChecks.title")}</h2><p className="jf-field__hint">{t("health.pluginChecks.hint")}</p></div><span className="jf-badge jf-badge--info">{t("health.pluginChecks.count", { count: report.pluginChecks.length })}</span></div>
          <div className="jf-card__body jf-card__body--flush">{report.pluginChecks.length === 0 ? <div className="jf-empty"><p>{t("health.pluginChecks.none")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.pluginChecks.colPlugin")}</th><th>{t("health.pluginChecks.colCheck")}</th><th>{t("health.pluginChecks.colStatus")}</th><th>{t("health.pluginChecks.colSummary")}</th></tr></thead><tbody>{report.pluginChecks.map((check) => <tr key={`${check.pluginId}/${check.id}`}><td className="jf-td--mono">{check.pluginId}</td><td>{check.label}<br /><code className="jf-code">{check.id}</code></td><td><span className={`jf-badge jf-badge--${check.result.status === "error" ? "error" : check.result.status === "warning" ? "warn" : "ok"}`}>{check.result.status}</span></td><td>{check.result.summary}</td></tr>)}</tbody></table></div>}</div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.cli.title")}</h2><p className="jf-field__hint">{t("health.cli.hint")}</p></div><button type="button" className="jf-btn jf-btn--ghost" onClick={() => void copyCliCommands()}>{cliCopied ? t("health.cli.copied") : t("health.cli.copy")}</button></div>
          <div className="jf-card__body"><pre className="jf-code">{cliCommands}</pre></div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.traces.title")}</h2><p className="jf-field__hint">{t("health.traces.hint")}</p></div><span className="jf-badge jf-badge--info">{t("health.traces.retained", { count: report.traces.length })}</span></div>
          <div className="jf-card__body jf-card__body--flush">
            {report.traces.length === 0 ? <div className="jf-empty"><p>{t("health.traces.none")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.traces.colRequest")}</th><th>{t("health.traces.colPage")}</th><th>{t("health.traces.colTime")}</th><th>{t("health.traces.colCache")}</th><th>{t("health.traces.colDatabase")}</th><th>{t("health.traces.colHooks")}</th><th>{t("health.traces.colResolution")}</th></tr></thead><tbody>{report.traces.map((trace) => <tr key={trace.requestId} className={trace.requestId === requestedTraceId ? "jf-table__row--highlight" : undefined}><td className="jf-td--mono">{trace.requestId}</td><td><strong>{trace.path}</strong><br /><span className="jf-field__hint">{new Date(trace.timestamp).toLocaleTimeString()}</span></td><td>{t("health.units.milliseconds", { value: trace.durationMs.toFixed(1) })}</td><td>{trace.pageCache}<br /><span className="jf-field__hint">{trace.objectCache}</span></td><td>{t("health.traces.opsCount", { count: trace.databaseQueries })}<br /><span className="jf-field__hint">{t("health.units.milliseconds", { value: trace.databaseMs.toFixed(1) })}</span></td><td>{t("health.traces.runsCount", { count: trace.hookRuns })}<br /><span className="jf-field__hint">{t("health.traces.errorsCount", { count: trace.hookErrors })}</span></td><td><code className="jf-code">{trace.theme}</code><br /><span className="jf-field__hint">{trace.template}</span></td></tr>)}</tbody></table></div>}
          </div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.hooks.title")}</h2><p className="jf-field__hint">{t("health.hooks.hint")}</p></div><div className="jf-row"><span className="jf-badge jf-badge--info">{t("health.hooks.handlersCount", { count: report.hooks.totals.handlers })}</span><span className={`jf-badge jf-badge--${report.hooks.totals.errors ? "error" : "ok"}`}>{t("health.hooks.errorsCount", { count: report.hooks.totals.errors })}</span></div></div>
          <div className="jf-card__body jf-card__body--flush">
            {report.hooks.handlers.length === 0 ? <div className="jf-empty"><p>{t("health.hooks.none")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.hooks.colHook")}</th><th>{t("health.hooks.colOwner")}</th><th>{t("health.hooks.colPriority")}</th><th>{t("health.hooks.colRuns")}</th><th>{t("health.hooks.colDuration")}</th><th>{t("health.hooks.colStatus")}</th></tr></thead><tbody>{report.hooks.handlers.map((hook, index) => <tr key={`${hook.hook}-${hook.priority}-${index}`}><td className="jf-td--mono">{hook.hook}</td><td>{hook.pluginId ?? t("health.hooks.core")}</td><td>{hook.priority}</td><td>{hook.runs}</td><td>{t("health.units.milliseconds", { value: hook.totalMs.toFixed(1) })}</td><td><span className={`jf-badge jf-badge--${hook.disabled || hook.errors ? "error" : "ok"}`}>{hook.disabled ? t("health.hooks.disabled") : hook.errors ? t("health.hooks.errorsCount", { count: hook.errors }) : t("health.hooks.healthy")}</span></td></tr>)}</tbody></table></div>}
          </div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.plugins.title")}</h2><p className="jf-field__hint">{t("health.plugins.hint")}</p></div><span className="jf-badge jf-badge--info">{t("health.plugins.foundCount", { count: report.extensions.plugins.length })}</span></div>
          <div className="jf-card__body jf-card__body--flush">
            {report.extensions.plugins.length === 0 ? <div className="jf-empty"><p>{t("health.plugins.none")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.plugins.colPlugin")}</th><th>{t("health.plugins.colSource")}</th><th>{t("health.plugins.colVersion")}</th><th>{t("health.plugins.colPermissions")}</th><th>{t("health.plugins.colDatabase")}</th><th>{t("health.plugins.colFiles")}</th></tr></thead><tbody>{report.extensions.plugins.map((plugin, index) => <tr key={`${plugin.source}-${plugin.id}-${plugin.version}-${index}`}><td><strong>{plugin.name}</strong><br /><code className="jf-code">{plugin.id}</code>{plugin.path && <><br /><span className="jf-field__hint">{plugin.path}</span></>}</td><td><span className={`jf-badge jf-badge--${plugin.source === "development" ? "warn" : "info"}`}>{plugin.source}</span></td><td>{plugin.version}</td><td className="jf-td--muted">{plugin.permissions.join(", ") || t("health.plugins.noPermissions")}</td><td><span className={`jf-badge jf-badge--${plugin.registered ? plugin.status === "error" ? "error" : plugin.status === "active" ? "ok" : "info" : "warn"}`}>{plugin.registered ? plugin.status : t("health.plugins.notRegistered")}</span></td><td><span className={`jf-badge jf-badge--${plugin.onDisk ? "ok" : "error"}`}>{plugin.onDisk ? t("health.plugins.present") : t("health.plugins.missing")}</span></td></tr>)}</tbody></table></div>}
          </div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.themes.title")}</h2><p className="jf-field__hint">{t("health.themes.hint")}</p></div><span className="jf-badge jf-badge--info">{t("health.themes.foundCount", { count: report.extensions.themes.length })}</span></div>
          <div className="jf-card__body jf-card__body--flush">
            {report.extensions.themes.length === 0 ? <div className="jf-empty"><p>{t("health.themes.none")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.themes.colTheme")}</th><th>{t("health.themes.colSource")}</th><th>{t("health.themes.colVersion")}</th><th>{t("health.themes.colDatabase")}</th><th>{t("health.themes.colFiles")}</th></tr></thead><tbody>{report.extensions.themes.map((theme, index) => <tr key={`${theme.source}-${theme.id}-${theme.version}-${index}`}><td><strong>{theme.name}</strong><br /><code className="jf-code">{theme.id}</code>{theme.path && <><br /><span className="jf-field__hint">{theme.path}</span></>}</td><td><span className={`jf-badge jf-badge--${theme.source === "development" ? "warn" : "info"}`}>{theme.source}</span></td><td>{theme.version}</td><td><span className={`jf-badge jf-badge--${theme.registered ? theme.status === "error" ? "error" : theme.status === "active" ? "ok" : "info" : "warn"}`}>{theme.registered ? theme.status : t("health.plugins.notRegistered")}</span></td><td><span className={`jf-badge jf-badge--${theme.onDisk ? "ok" : "error"}`}>{theme.onDisk ? t("health.plugins.present") : t("health.plugins.missing")}</span></td></tr>)}</tbody></table></div>}
          </div>
        </section>

        <section className="jf-card">
          <div className="jf-card__head"><div><h2 className="jf-card__title">{t("health.recentErrors.title")}</h2><p className="jf-field__hint">{t("health.recentErrors.hint")}</p></div><span className={`jf-badge jf-badge--${report.errors.length ? "warn" : "ok"}`}>{t("health.recentErrors.capturedCount", { count: report.errors.length })}</span></div>
          <div className="jf-card__body jf-card__body--flush">
            {report.errors.length === 0 ? <div className="jf-empty"><p>{t("health.recentErrors.none")}</p></div> : <div className="jf-tablewrap"><table className="jf-table"><thead><tr><th>{t("health.recentErrors.colTime")}</th><th>{t("health.recentErrors.colContext")}</th><th>{t("health.recentErrors.colMessage")}</th><th>{t("health.recentErrors.colRequestId")}</th></tr></thead><tbody>{report.errors.map((entry) => <tr key={entry.id}><td>{new Date(entry.timestamp).toLocaleTimeString()}</td><td className="jf-td--strong">{entry.context}</td><td>{entry.message}</td><td className="jf-td--mono">{entry.requestId ?? t("health.recentErrors.backgroundTask")}</td></tr>)}</tbody></table></div>}
          </div>
        </section>

        <div className="jf-banner jf-banner--ok">
          <span className="jf-banner__icon" aria-hidden="true">✓</span>
          <div><div className="jf-banner__title">{t("health.footer.safeTitle")}</div><div className="jf-banner__sub">{t("health.footer.safeDetail", { date: new Date(report.generatedAt).toLocaleString() })}</div></div>
        </div>
      </>}
    </div>
  );
}
