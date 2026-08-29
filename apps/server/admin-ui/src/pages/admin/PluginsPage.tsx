import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePluginMenu } from "@components/PluginMenuProvider";
import { useSessionRole } from "@components/SessionProvider";
import { useT } from "../../i18n/I18nProvider";

interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  status: "active" | "inactive" | "installed" | "error";
  publisher: string;
  settingsSchema?: Record<string, unknown>;
  setupPath?: string;
}

const STATUS_VARIANT: Record<Plugin["status"], string> = {
  active: " jf-badge--ok",
  inactive: "",
  installed: " jf-badge--info",
  error: " jf-badge--error",
};

export default function PluginsPage() {
  // Upload, activate/deactivate, delete, and per-plugin settings are all
  // administrator-only on the server; an editor can only read this list.
  const canManage = useSessionRole() === "administrator";
  const { t } = useT();
  const navigate = useNavigate();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Installing, activating, or deleting a plugin changes which admin pages exist.
  const { refresh: refreshMenu } = usePluginMenu();

  useEffect(() => {
    fetch("/api/plugins")
      .then((r) => r.json())
      .then((data: { plugins?: Plugin[] }) => {
        if (Array.isArray(data.plugins)) setPlugins(data.plugins);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleFile(file: File) {
    if (!file.name.endsWith(".jfpkg") && !file.name.endsWith(".zip")) {
      setUploadError("Please upload a .jfpkg file");
      return;
    }

    setUploading(true);
    setUploadError("");
    setUploadSuccess("");

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 45_000);

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/plugins", { method: "POST", body: form, signal: controller.signal });
      const raw = await res.text();
      let data: { plugin?: Plugin; error?: string } = {};
      try {
        data = JSON.parse(raw) as { plugin?: Plugin; error?: string };
      } catch {
        const plain = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        throw new Error(plain.slice(0, 180) || `Upload failed (${res.status})`);
      }
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      if (data.plugin) {
        setPlugins((p) => [...p, data.plugin!]);
        setUploadSuccess(`"${data.plugin.name}" installed successfully`);
        await refreshMenu();
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setUploadError("Install timed out. Extract the latest justflows.zip, run npm run install:all, and restart Node.js.");
      } else {
        setUploadError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      window.clearTimeout(timer);
      setUploading(false);
    }
  }

  async function togglePlugin(id: string, currentStatus: Plugin["status"]) {
    const action = currentStatus === "active" ? "deactivate" : "activate";
    const res = await fetch(`/api/plugins/${id}/${action}`, { method: "POST" });
    if (res.ok) {
      setPlugins((list) => list.map((p) =>
        p.id === id ? { ...p, status: action === "activate" ? "active" : "inactive" } : p));
      await refreshMenu();
      if (action === "activate") {
        const data = (await res.json().catch(() => ({}))) as { setupPath?: string };
        if (typeof data.setupPath === "string" && data.setupPath.startsWith("/admin/")) {
          navigate(data.setupPath);
        }
      }
    }
  }

  async function deletePlugin(plugin: Plugin) {
    if (!confirm(t("plugins.deleteConfirm", { name: plugin.name }))) return;
    setDeleteError("");
    const res = await fetch(`/api/plugins/${encodeURIComponent(plugin.id)}`, { method: "DELETE" });
    const data = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
    if (!res.ok) {
      setDeleteError(data.error ?? t("plugins.deleteFailed"));
      return;
    }
    setPlugins((list) => list.filter((p) => p.id !== plugin.id));
    if (data.warning) setDeleteError(data.warning);
    await refreshMenu();
  }

  return (
    <div className="jf-page">
      <header className="jf-pagehead">
        <div className="jf-pagehead__text">
          <h1>Plugins</h1>
          <p>Extend your site with plugins</p>
        </div>
      </header>

      {canManage && (
      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Upload plugin</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <div
            className="jf-dropzone jf-dropzone--tall"
            data-dragging={dragging}
            role="button"
            tabIndex={0}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
            aria-label="Upload a plugin package. Drop a .jfpkg file here or press Enter to browse."
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".jfpkg,.zip"
              aria-label="Choose a plugin package"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            <span className="jf-dropzone__icon" aria-hidden="true">📦</span>
            <span className="jf-dropzone__title">
              {uploading ? "Installing…" : "Drop a .jfpkg file here"}
            </span>
            <span>or click to browse</span>
          </div>

          {uploadError && <div className="jf-alert jf-alert--error" role="alert">{uploadError}</div>}
          {uploadSuccess && <div className="jf-alert jf-alert--success" role="status">{uploadSuccess}</div>}
        </div>
      </div>
      )}

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">Installed plugins ({plugins.length})</h2>
        </div>

        {deleteError && (
          <div className="jf-card__body">
            <div className="jf-alert jf-alert--error" role="alert">{deleteError}</div>
          </div>
        )}

        {loading ? (
          <div className="jf-card__body jf-stack jf-stack--sm">
            <div className="jf-skeleton" style={{ height: 64 }} />
            <div className="jf-skeleton" style={{ height: 64 }} />
          </div>
        ) : plugins.length === 0 ? (
          <div className="jf-empty">
            <span className="jf-empty__icon" aria-hidden="true">🔌</span>
            <span className="jf-empty__title">No plugins installed</span>
            <p>Upload a .jfpkg file above to add functionality to your site.</p>
          </div>
        ) : (
          <div className="jf-list">
            {plugins.map((p) => (
              <div key={p.id} className="jf-list__row" style={{ alignItems: "center" }}>
                <div className="jf-list__main">
                  <div className="jf-row" style={{ gap: "0.5rem" }}>
                    <strong>{p.name}</strong>
                    <span className="jf-meta">v{p.version}</span>
                    <span className={`jf-badge${STATUS_VARIANT[p.status]}`}>{p.status}</span>
                  </div>
                  {p.description && <p className="jf-list__desc">{p.description}</p>}
                  <p className="jf-meta">by {p.publisher} · <code className="jf-code">{p.id}</code></p>
                </div>
                {canManage && (
                  <div className="jf-row" style={{ flexWrap: "nowrap" }}>
                    {p.settingsSchema && Object.keys(p.settingsSchema).length > 0 && (
                      <Link className="jf-btn jf-btn--ghost" to={`/admin/plugins/${p.id}/settings`}>
                        Settings
                      </Link>
                    )}
                    <button className="jf-btn jf-btn--ghost" onClick={() => togglePlugin(p.id, p.status)}>
                      {p.status === "active" ? "Deactivate" : "Activate"}
                    </button>
                    <button className="jf-btn jf-btn--danger" onClick={() => void deletePlugin(p)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
