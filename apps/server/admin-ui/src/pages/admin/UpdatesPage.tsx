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

interface UpdateResult {
  ok?: boolean;
  error?: string;
  steps?: UpdateStep[];
  currentVersion?: string;
  newVersion?: string;
  restartRequired?: boolean;
  restarting?: boolean;
}

function logVariant(line: string): string {
  if (line.startsWith("✓")) return " jf-log__line--ok";
  if (line.startsWith("✗")) return " jf-log__line--fail";
  if (line.startsWith("⚠")) return " jf-log__line--warn";
  if (line.startsWith("↻")) return " jf-log__line--info";
  return "";
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
  const [log, setLog] = useState<string[]>([]);
  const [restartFailed, setRestartFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/updates")
      .then((r) => r.json())
      .then((data: { currentVersion?: string; updates?: UpdateItem[]; autoUpdate?: AutoUpdateInfo }) => {
        if (data.currentVersion) setCurrentVersion(data.currentVersion);
        if (data.updates) setUpdates(data.updates);
        if (data.autoUpdate) setAutoUpdate(data.autoUpdate);
      })
      .catch(() => {});
  }, []);

  function addLog(line: string) {
    setLog((l) => [...l, line]);
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

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForSiteBack() {
    setRestarting(true);
    addLog("↻ App is restarting — waiting for site to come back…");
    await sleep(4000);

    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const res = await fetch("/api/install/status", { cache: "no-store" });
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

  async function runUpdateFlow(request: Promise<Response>) {
    setRestarting(false);
    setRestartFailed(false);

    try {
      const res = await request;
      const data = (await res.json()) as UpdateResult;

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
    } catch (e) {
      addLog(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function uploadZip(file: File) {
    setUploading(true);
    setLog([]);
    addLog(`Uploading ${file.name}…`);
    addLog("This may take several minutes (extract → npm install → build)…");

    const form = new FormData();
    form.append("file", file);
    await runUpdateFlow(fetch("/api/updates/upload", { method: "POST", body: form }));

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function installRemote(item: UpdateItem) {
    setInstalling(true);
    setLog([]);
    addLog(`Downloading Justflows v${item.availableVersion}…`);
    addLog("This may take several minutes (download → verify → extract → npm install → build)…");

    await runUpdateFlow(
      fetch("/api/updates/remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: item.availableVersion }),
      }),
    );

    setInstalling(false);
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
                ? "Updating… (please wait)"
                : restarting
                  ? "Restarting…"
                  : "Choose justflows.zip…"}
            </button>
            {busy && (
              <span className="jf-meta">
                {uploading || installing
                  ? "Running npm install and build — do not close this page"
                  : "Waiting for app to restart — page will reload automatically"}
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
                      ? "Updating…"
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
          <p className="jf-log__label">Update log</p>
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
