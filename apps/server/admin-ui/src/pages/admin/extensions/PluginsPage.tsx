import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "../../../admin-router";
import { usePluginMenu } from "@components/PluginMenuProvider";
import { useSession, useSessionRole } from "@components/SessionProvider";
import { useT } from "../../../i18n/I18nProvider";
import {
  ExtensionAutoUpdateToggle,
  ExtensionUpdateBadge,
  ExtensionUpdateButton,
  ExtensionUpdatesBar,
  useExtensionUpdates,
} from "@components/ExtensionUpdates";
import { sendWithPermissionApproval } from "../../../lib/plugin-permission-approval";

interface Plugin {
  id: string;
  name: string;
  /** Absent on sites other than the main site, which decides the version. */
  version?: string;
  description?: string;
  status: "active" | "inactive" | "installed" | "error";
  publisher: string;
  settingsSchema?: Record<string, unknown>;
  setupPath?: string;
  allowMultisite?: boolean;
  multisiteEnabled?: boolean;
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
  const installationRoot = useSession().session?.installationRoot !== false;
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
  const updates = useExtensionUpdates(canManage);

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
      setUploadError(t("plugins.uploadInvalidFile"));
      return;
    }

    setUploading(true);
    setUploadError("");
    setUploadSuccess("");

    try {
      const res = await sendWithPermissionApproval(
        (approved, signal) => {
          const form = new FormData();
          form.append("file", file);
          if (approved) form.append("approvedPermissions", JSON.stringify(approved));
          return fetch("/api/plugins", { method: "POST", body: form, signal });
        },
        (name, permissions) =>
          confirm(t("plugins.permissionApprovalConfirm", { name, permissions: permissions.join("\n") })),
        45_000,
      );
      const raw = await res.text();
      let data: { plugin?: Plugin; error?: string } = {};
      try {
        data = JSON.parse(raw) as { plugin?: Plugin; error?: string };
      } catch {
        const plain = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        throw new Error(plain.slice(0, 180) || t("common.uploadFailedStatus", { status: res.status }));
      }
      if (!res.ok) throw new Error(data.error ?? t("plugins.uploadFailed"));
      if (data.plugin) {
        setPlugins((p) => [...p, data.plugin!]);
        setUploadSuccess(t("plugins.uploadSuccess", { name: data.plugin.name }));
        await refreshMenu();
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setUploadError(t("plugins.installTimeout"));
      } else {
        setUploadError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setUploading(false);
    }
  }

  async function togglePlugin(plugin: Plugin) {
    const action = plugin.status === "active" ? "deactivate" : "activate";
    if (action === "deactivate" && !installationRoot) {
      if (!confirm(t("plugins.deactivateSiteConfirm", { name: plugin.name }))) return;
    }
    const res = await fetch(`/api/plugins/${encodeURIComponent(plugin.id)}/${action}`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { setupPath?: string; error?: string };
    if (!res.ok) {
      setDeleteError(data.error ?? t(action === "deactivate" ? "plugins.deactivateFailed" : "plugins.activateFailed"));
      return;
    }
    setPlugins((list) =>
      list.map((p) =>
        p.id === plugin.id ? { ...p, status: action === "activate" ? "active" : "inactive" } : p,
      ),
    );
    await refreshMenu();
    if (action === "activate") {
      if (typeof data.setupPath === "string" && data.setupPath.startsWith("/admin/")) {
        navigate(data.setupPath);
      }
    }
  }

  async function setMultisite(id: string, enabled: boolean) {
    const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/multisite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setDeleteError(data.error ?? t("plugins.multisiteFailed"));
      return;
    }
    setPlugins((list) => list.map((item) => (item.id === id ? { ...item, multisiteEnabled: enabled } : item)));
  }

  async function deletePlugin(plugin: Plugin) {
    const confirmKey = installationRoot ? "plugins.deleteConfirm" : "plugins.removeFromSiteConfirm";
    if (!confirm(t(confirmKey, { name: plugin.name }))) return;
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
          <h1>{t("plugins.title")}</h1>
          <p>{installationRoot ? t("plugins.subtitle") : t("plugins.subtitleSite")}</p>
        </div>
      </header>

      {canManage && installationRoot && (
      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("plugins.uploadHeading")}</h2>
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
            aria-label={t("plugins.uploadDropzoneAriaLabel")}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".jfpkg,.zip"
              aria-label={t("plugins.choosePackageAriaLabel")}
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            <span className="jf-dropzone__icon" aria-hidden="true">📦</span>
            <span className="jf-dropzone__title">
              {uploading ? t("plugins.installing") : t("plugins.dropHere")}
            </span>
            <span>{t("plugins.orClickToBrowse")}</span>
          </div>

          {uploadError && <div className="jf-alert jf-alert--error" role="alert">{uploadError}</div>}
          {uploadSuccess && <div className="jf-alert jf-alert--success" role="status">{uploadSuccess}</div>}
        </div>
      </div>
      )}

      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("plugins.installedHeading", { count: plugins.length })}</h2>
        </div>

        {canManage && installationRoot && (
          <div className="jf-card__body">
            <ExtensionUpdatesBar state={updates} />
          </div>
        )}

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
            <span className="jf-empty__title">{t("plugins.emptyTitle")}</span>
            <p>{installationRoot ? t("plugins.emptyDesc") : t("plugins.emptyDescSite")}</p>
          </div>
        ) : (
          <div className="jf-list">
            {plugins.map((p) => (
              <div key={p.id} className="jf-list__row" style={{ alignItems: "center" }}>
                <div className="jf-list__main">
                  <div className="jf-row" style={{ gap: "0.5rem" }}>
                    <strong>{p.name}</strong>
                    {p.version && <span className="jf-meta">v{p.version}</span>}
                    <span className={`jf-badge${STATUS_VARIANT[p.status]}`}>{p.status}</span>
                    {canManage && installationRoot && <ExtensionUpdateBadge state={updates} type="plugin" id={p.id} />}
                  </div>
                  {p.description && <p className="jf-list__desc">{p.description}</p>}
                  <p className="jf-meta">{t("ui.pluginsPage.by")}{p.publisher} · <code className="jf-code">{p.id}</code></p>
                  {canManage && installationRoot && (
                    <label className="jf-row" style={{ gap: "0.5rem" }}>
                      <input
                        type="checkbox"
                        checked={p.multisiteEnabled === true}
                        onChange={(e) => void setMultisite(p.id, e.target.checked)}
                      />
                      <span>{t("plugins.multisiteEnable")}</span>
                    </label>
                  )}
                  {canManage && installationRoot && (
                    <p className="jf-meta">{t("plugins.multisiteHint")}</p>
                  )}
                  {canManage && installationRoot && <ExtensionAutoUpdateToggle state={updates} type="plugin" id={p.id} />}
                </div>
                {canManage && (
                  <div className="jf-row" style={{ flexWrap: "nowrap" }}>
                    {installationRoot && (
                    <ExtensionUpdateButton
                      state={updates}
                      type="plugin"
                      id={p.id}
                      onUpdated={(result) => {
                        setPlugins((list) => list.map((item) =>
                          item.id === result.id
                            ? {
                                ...item,
                                version: result.version,
                                ...(result.activationError ? { status: "error" as const } : {}),
                              }
                            : item));
                        void refreshMenu();
                      }}
                    />
                    )}
                    {p.settingsSchema && Object.keys(p.settingsSchema).length > 0 && (
                      <Link className="jf-btn jf-btn--ghost" to={`/admin/plugins/${p.id}/settings`}>
                        {t("plugins.settingsLink")}
                      </Link>
                    )}
                    <button className="jf-btn jf-btn--ghost" onClick={() => void togglePlugin(p)}>
                      {p.status === "active" ? t("plugins.deactivate") : t("plugins.activate")}
                    </button>
                    {installationRoot && (
                      <button className="jf-btn jf-btn--danger" onClick={() => void deletePlugin(p)}>
                        {t("common.delete")}
                      </button>
                    )}
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
