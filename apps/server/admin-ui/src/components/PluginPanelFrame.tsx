import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { internalAdminPath, publicAdminPath } from "../admin-path";
import { useT } from "../i18n/I18nProvider";

const PLUGIN_MSG = "justflows-admin-plugin";
const HOST_MSG = "justflows-admin-host";
const PLUGIN_ID = /^justflows(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const APP_PATH = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The record a panel frame is embedded for. */
export interface PluginPanelTarget {
  /** Content row open in the editor. */
  contentId?: string;
  /** Workspace open on Platform → Workspace. */
  workspaceId?: string;
}

/**
 * The plugin's own screen for one record, embedded in a host page.
 * The host only knows the plugin, the relative app path, and the record id.
 */
export default function PluginPanelFrame({
  pluginId,
  app,
  target,
  catalogs,
  title,
}: {
  pluginId: string;
  app: string;
  target: PluginPanelTarget;
  catalogs?: Record<string, string>;
  title: string;
}) {
  const { contentId, workspaceId } = target;
  const { locale } = useT();
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(280);
  const routePath = `${internalAdminPath("/admin")}/plugins/${pluginId}/${app}`;

  const post = useCallback((message: Record<string, unknown>) => {
    const win = frameRef.current?.contentWindow;
    if (win) win.postMessage({ source: HOST_MSG, ...message }, window.location.origin);
  }, []);

  const sendContext = useCallback(() => {
    const theme = document.documentElement.dataset.theme ?? "";
    post({
      type: "context",
      context: {
        locale,
        adminBase: internalAdminPath("/admin"),
        routePath,
        theme,
        ...(contentId ? { contentId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(catalogs ? { catalogs } : {}),
      },
    });
  }, [post, locale, routePath, contentId, workspaceId, catalogs]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; [key: string]: unknown };
      if (!data || data.source !== PLUGIN_MSG) return;
      if (data.type === "ready") {
        sendContext();
        return;
      }
      if (data.type === "resize") {
        const next = Number(data.height);
        if (Number.isFinite(next)) setHeight(Math.min(720, Math.max(220, Math.ceil(next))));
        return;
      }
      if (data.type === "navigate") {
        const to = String(data.path ?? "");
        if (/^\/admin(\/|$)/.test(to) && !to.includes("..")) navigate(publicAdminPath(to));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate, sendContext]);

  useEffect(() => {
    sendContext();
  }, [sendContext]);

  if (!PLUGIN_ID.test(pluginId) || !APP_PATH.test(app)) return null;

  return (
    <iframe
      ref={frameRef}
      src={`/ext/${pluginId}/admin/index.html?v=20261031c`}
      title={title}
      className="jf-plugin-frame"
      style={{ height, border: 0, borderRadius: 0, minHeight: 220 }}
      onLoad={sendContext}
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
    />
  );
}
