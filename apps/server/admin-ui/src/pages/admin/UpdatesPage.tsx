import { useEffect, useRef, useState } from "react";
import { initialJson } from "../../ssr-data";

interface UpdateStep {
  step: string;
  ok: boolean;
  detail?: string;
}

interface UpdateItem {
  id: string;
  name: string;
  type: "core" | "plugin" | "theme";
  currentVersion: string;
  availableVersion: string;
  changelog?: string;
  notesUrl?: string;
  publishedAt?: string | null;
  autoUpdatable?: boolean;
}

interface AutoUpdateInfo {
  enabled: boolean;
  available: boolean;
  maxScope: string;
}

interface UpdateStatus {
  running: boolean;
  phase: string;
  source: "upload" | "remote" | "auto" | null;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  currentVersion: string | null;
  targetVersion: string | null;
  newVersion: string | null;
  ok: boolean | null;
  error: string | null;
  restartRequired: boolean;
  restarting: boolean;
  steps: UpdateStep[];
  log: string[];
}

interface StartResponse {
  started?: boolean;
  background?: boolean;
  ok?: boolean;
  error?: string;
  steps?: UpdateStep[];
  currentVersion?: string;
  newVersion?: string;
  restartRequired?: boolean;
  restarting?: boolean;
  status?: UpdateStatus;
}

const PHASE_LABEL: Record<string, string> = {
  queued: "Queued",
  downloading: "Downloading",
  verifying: "Verifying",
  extracting: "Extracting",
  validating: "Validating",
  copying: "Copying files",
  migrating: "Running migrations",
  installing: "Installing dependencies",
  building: "Building",
  restarting: "Restarting",
  done: "Done",
  failed: "Failed",
};

function logVariant(line: string): string {
  if (line.startsWith("✓")) return " jf-log__line--ok";
  if (line.startsWith("✗")) return " jf-log__line--fail";
  if (line.startsWith("⚠")) return " jf-log__line--warn";
  if (line.startsWith("↻")) return " jf-log__line--info";
  return "";
}

/** fetch() with a hard timeout — a wedged server must not hang the UI forever. */
function fetchWithTimeout(input: string, init: RequestInit = {}, ms = 30_000): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}

export default function UpdatesPage() {
  const prefetched = initialJson<{
    currentVersion?: string;
    version?: string;
    updates?: UpdateItem[];
    autoUpdate?: AutoUpdateInfo;
  }>("/api/updates");
  const [currentVersion, setCurrentVersion] = useState(
    prefetched?.currentVersion ?? prefetched?.version ?? "…",
  );
  const [updates, setUpdates] = useState<UpdateItem[]>(prefetched?.updates ?? []);
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateInfo>(
    prefetched?.autoUpdate ?? { enabled: false, available: true, maxScope: "minor" },
  );
  const [savingAuto, setSavingAuto] = useState(false);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [restartFailed, setRestartFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollFailures = useRef(0);

  useEffect(() => {
    fetch("/api/updates")
      .then((r) => r.json())
      .then(
        (data: {
          currentVersion?: string;
          updates?: UpdateItem[];
          autoUpdate?: AutoUpdateInfo;
        }) => {
          if (data.currentVersion) setCurrentVersion(data.currentVersion);
          if (data.updates) setUpdates(data.updates);
          if (data.autoUpdate) setAutoUpdate(data.autoUpdate);
        },
      )
      .catch(() => {});

    // Re-attach to an update that is already running (e.g. after a page reload).
    fetch("/api/updates/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((status: UpdateStatus) => {
        if (status.running || status.phase === "restarting") {
          setInstalling(true);
          applyStatus(status);
          startPolling();
        }
      })
      .catch(() => {});

    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function addLog(line: string) {
    setLog((l) => [...l, line]);
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Render a status snapshot into the log/phase UI. */
  function applyStatus(status: UpdateStatus) {
    setPhase(status.phase);
    if (status.log?.length) setLog(status.log);
    else if (status.steps?.length) {
      setLog(
        status.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.step}${s.detail ? `: ${s.detail}` : ""}`),
      );
    }
    if (status.newVersion) setCurrentVersion(status.newVersion);
  }

  function finishRun(status: UpdateStatus) {
    stopPolling();
    setInstalling(false);
    setUploading(false);
    if (status.ok && status.restarting) {
      void waitForSiteBack();
    } else if (status.restartRequired) {
      setRestartFailed(true);
      addLog("⚠ Could not auto-restart — restart manually in Plesk → Node.js");
    }
  }

  async function pollOnce() {
    try {
      const res = await fetchWithTimeout("/api/updates/status", { cache: "no-store" }, 15_000);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const status = (await res.json()) as UpdateStatus;
      pollFailures.current = 0;
      applyStatus(status);
      if (!status.running && (status.phase === "done" || status.phase === "failed")) {
        finishRun(status);
        return;
      }
    } catch {
      // The app may be mid-restart; keep polling for a while — but not forever.
      pollFailures.current += 1;
      if (pollFailures.current > 120) {
        stopPolling();
        setInstalling(false);
        setUploading(false);
        setRestartFailed(true);
        addLog("⚠ Lost contact with the server — refresh this page to check the result");
        return;
      }
    }
    pollTimer.current = setTimeout(() => void pollOnce(), 2500);
  }

  function startPolling() {
    stopPolling();
    pollFailures.current = 0;
    pollTimer.current = setTimeout(() => void pollOnce(), 1500);
  }

  async function checkForUpdates() {
    setChecking(true);
    setLog([]);
    try {
      const res = await fetch("/api/updates", { cache: "no-store" });
      const data = (await res.json()) as {
        updates: UpdateItem[];
        currentVersion?: string;
        autoUpdate?: AutoUpdateInfo;
      };
      setUpdates(data.updates ?? []);
      if (data.currentVersion) setCurrentVersion(data.currentVersion);
      if (data.autoUpdate) setAutoUpdate(data.autoUpdate);
      addLog(
        data.updates?.length
          ? `Found ${data.updates.length} update(s)`
          : "Everything is up to date",
      );
    } finally {
      setChecking(false);
    }
  }

  async function waitForSiteBack() {
    setRestarting(true);
    setPhase("restarting");
    addLog("↻ App is restarting — waiting for site to come back…");
    await sleep(4000);

    for (let attempt = 0; attempt < 45; attempt++) {
      try {
        const res = await fetchWithTimeout("/api/install/status", { cache: "no-store" }, 5000);
        if (res.ok) {
          addLog("✓ Site is back online — reloading…");
          await sleep(1500);
          window.location.reload();
          return;
        }
      } catch {
        // expected while Passenger restarts
      }
      await sleep(2000);
    }

    setRestartFailed(true);
    addLog("⚠ Restart may still be in progress — refresh the page manually if needed");
    setRestarting(false);
  }

  /**
   * Kick off an update. The server either runs it in a detached worker (202 +
   * `background: true`) — we then poll `/api/updates/status` — or, on the one
   * transitional build that predates the worker, runs it inline and returns the
   * full result.
   */
  async function runUpdateFlow(request: Promise<Response>) {
    setRestarting(false);
    setRestartFailed(false);
    setPhase("queued");

    try {
      const res = await request;
      let data: StartResponse;
      try {
        data = (await res.json()) as StartResponse;
      } catch {
        data = {};
      }

      if (res.status === 409) {
        addLog(`⚠ ${data.error ?? "An update is already running"}`);
        if (data.status) applyStatus(data.status);
        startPolling();
        return;
      }

      if (data.background) {
        if (data.status) applyStatus(data.status);
        addLog("↻ Update running in the background…");
        startPolling();
        return;
      }

      // Inline (compatibility) result.
      if (data.steps) {
        for (const step of data.steps) {
          addLog(`${step.ok ? "✓" : "✗"} ${step.step}${step.detail ? `: ${step.detail}` : ""}`);
        }
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error ?? data.steps?.find((s) => !s.ok)?.detail ?? "Update failed");
      }
      if (data.newVersion) setCurrentVersion(data.newVersion);
      if (data.restarting) {
        await waitForSiteBack();
      } else if (data.restartRequired) {
        setRestartFailed(true);
        addLog("⚠ Could not auto-restart — restart manually in Plesk → Node.js");
      }
      setInstalling(false);
      setUploading(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A dropped connection here usually means the worker is busy or the app is
      // restarting — fall back to polling rather than declaring failure.
      addLog(`⚠ ${msg} — checking update status…`);
      startPolling();
    }
  }

  async function uploadZip(file: File) {
    setUploading(true);
    setInstalling(true);
    setLog([]);
    addLog(`Uploading ${file.name}…`);

    const form = new FormData();
    form.append("file", file);
    try {
      // Long timeout: the upload body itself can be large; the pipeline no longer
      // runs inside this request.
      await runUpdateFlow(
        fetchWithTimeout("/api/updates/upload", { method: "POST", body: form }, 10 * 60 * 1000),
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function installRemote(item: UpdateItem) {
    setInstalling(true);
    setLog([]);
    addLog(`Starting update to Justflows v${item.availableVersion}…`);

    await runUpdateFlow(
      fetchWithTimeout(
        "/api/updates/remote",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: item.availableVersion }),
        },
        2 * 60 * 1000,
      ),
    );
  }

  /**
   * Re-download and reapply whatever the gateway currently publishes as
   * latest, even if it's the version already installed. Repairs a corrupted
   * install (bad copy, interrupted dependency install, a manually edited
   * file) without waiting on a new release — same pipeline as a normal
   * remote update, so it still restarts the site.
   */
  async function forceReinstall() {
    if (
      !window.confirm(
        `Force reinstall Justflows v${currentVersion}? This re-downloads and reapplies the current release and restarts the site.`,
      )
    ) {
      return;
    }
    setInstalling(true);
    setLog([]);
    addLog(`Force reinstalling Justflows v${currentVersion}…`);

    await runUpdateFlow(
      fetchWithTimeout(
        "/api/updates/remote",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
        },
        2 * 60 * 1000,
      ),
    );
  }

  async function toggleAutoUpdate(next: boolean) {
    setSavingAuto(true);
    try {
      const res = await fetch("/api/updates/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoUpdate: { enabled: next } }),
      });
      const data = (await res.json()) as { autoUpdate?: AutoUpdateInfo; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      if (data.autoUpdate) setAutoUpdate(data.autoUpdate);
    } catch (e) {
      addLog(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingAuto(false);
    }
  }

  const busy = uploading || installing || restarting;
  const phaseLabel = phase ? (PHASE_LABEL[phase] ?? phase) : null;

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>Updates</h1>
          <p>
            Current version: <strong>v{currentVersion}</strong>
          </p>
        </div>
        <div className="jf-pagehead__actions">
          <button
            className="jf-btn jf-btn--ghost"
            onClick={checkForUpdates}
            disabled={checking || busy}
          >
            {checking ? "Checking…" : "Check for updates"}
          </button>
          <button
            className="jf-btn jf-btn--ghost"
            onClick={forceReinstall}
            disabled={checking || busy}
            title="Re-download and reapply the current release — use this to repair a broken install"
          >
            Force reinstall
          </button>
        </div>
      </header>

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Upload Justflows update</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-prose">
            Upload a <code className="jf-code">justflows.zip</code> file. Justflows extracts it,
            updates the database, installs dependencies, and restarts the site by itself
            (Plesk/Passenger). Your <code className="jf-code">.env</code> and uploads are preserved.
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadZip(f);
            }}
          />

          <div className="jf-row">
            <button
              className="jf-btn jf-btn--primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              {uploading
                ? "Uploading…"
                : restarting
                  ? "Restarting…"
                  : installing
                    ? `Updating… ${phaseLabel ?? ""}`.trim()
                    : "Choose justflows.zip…"}
            </button>
            {busy && (
              <span className="jf-meta">
                {restarting
                  ? "Waiting for app to restart — page will reload automatically"
                  : "The update runs in the background — you can safely leave this page"}
              </span>
            )}
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
        </div>
      </div>

      {updates.length === 0 ? (
        <div className="jf-card">
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">
              ⬆
            </span>
            <span className="jf-empty__title">No remote updates available</span>
            <p>Use the upload above to install a new justflows.zip manually.</p>
          </div>
        </div>
      ) : (
        <div className="jf-card">
          <div className="jf-list">
            {updates.map((item) => (
              <div key={item.id} className="jf-list__row" style={{ alignItems: "center" }}>
                <div className="jf-list__main">
                  <div className="jf-list__title">
                    {item.name}
                    {item.autoUpdatable === false && (
                      <span className="jf-badge jf-badge--warn" style={{ marginLeft: 8 }}>
                        major
                      </span>
                    )}
                  </div>
                  <p className="jf-list__desc">
                    {item.currentVersion} →{" "}
                    <strong style={{ color: "var(--jf-success)" }}>{item.availableVersion}</strong>
                    {item.notesUrl && (
                      <>
                        {" · "}
                        <a href={item.notesUrl} target="_blank" rel="noreferrer">
                          Release notes
                        </a>
                      </>
                    )}
                  </p>
                  {item.autoUpdatable === false && (
                    <p className="jf-meta">
                      This is a major version upgrade and may include breaking changes. Review the
                      release notes before installing.
                    </p>
                  )}
                </div>
                {item.type === "core" ? (
                  <button
                    className="jf-btn jf-btn--primary"
                    onClick={() => installRemote(item)}
                    disabled={busy || checking}
                  >
                    {installing
                      ? `Updating… ${phaseLabel ?? ""}`.trim()
                      : restarting
                        ? "Restarting…"
                        : `Update to v${item.availableVersion}`}
                  </button>
                ) : (
                  <span className="jf-badge jf-badge--info">{item.type}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Automatic updates</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <label className="jf-row" style={{ alignItems: "center", gap: 10 }}>
            <input
              type="checkbox"
              checked={autoUpdate.enabled}
              disabled={!autoUpdate.available || savingAuto || busy}
              onChange={(e) => toggleAutoUpdate(e.target.checked)}
            />
            <span>
              Install new <code className="jf-code">0.x</code> releases automatically
            </span>
          </label>
          <p className="jf-prose">
            When on, Justflows checks daily and installs newer releases that keep the same major
            version (for example <code className="jf-code">v{currentVersion}</code> →{" "}
            <code className="jf-code">v0.x.y</code>). Major version upgrades are never installed
            automatically — they can carry breaking changes and always need your confirmation above.
          </p>
          {!autoUpdate.available && (
            <p className="jf-meta">
              Automatic updates are disabled on this server (
              <code className="jf-code">JUSTFLOWS_DISABLE_AUTO_UPDATE</code>).
            </p>
          )}
        </div>
      </div>

      {log.length > 0 && (
        <div className="jf-log">
          <p className="jf-log__label">
            Update log{phaseLabel && installing ? ` — ${phaseLabel}` : ""}
          </p>
          {log.map((line, i) => (
            <p key={i} className={`jf-log__line${logVariant(line)}`}>
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
