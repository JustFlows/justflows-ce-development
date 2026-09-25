import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useT } from "../../../i18n/I18nProvider";
import { parsePluginSections, type PluginEditorSection, type PluginMenuItem } from "../../../config/admin-nav";
import { internalAdminPath } from "../../../admin-path";

const PLUGIN_MSG = "justflows-admin-plugin";
const HOST_MSG = "justflows-admin-host";
const FRAME_MIN_HEIGHT = 240;
const FRAME_MAX_HEIGHT = 20000;

export type PluginContentFrameHandle = {
  save: () => Promise<{ ok: boolean; error?: string }>;
};

/**
 * Embeds a plugin admin app inside the content editor. The host only knows the
 * menu item (content type + admin app URL) and the row being edited.
 */
const PluginContentFrame = forwardRef<
  PluginContentFrameHandle,
  {
    item: PluginMenuItem;
    contentId: string;
    translationGroupId: string;
    hidden: boolean;
    sectionId?: string;
    onDirty: (dirty: boolean) => void;
    onSections: (sections: PluginEditorSection[]) => void;
  }
>(function PluginContentFrame({ item, contentId, translationGroupId, hidden, sectionId, onDirty, onSections }, ref) {
  const { locale } = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(FRAME_MIN_HEIGHT);
  const pending = useRef(new Map<string, (result: { ok: boolean; error?: string }) => void>());

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
        routePath: item.path,
        theme,
        contentId,
        translationGroupId,
        ...(sectionId ? { sectionId } : {}),
        ...(item.adminCatalogs ? { catalogs: item.adminCatalogs } : {}),
      },
    });
  }, [post, locale, item.path, item.adminCatalogs, contentId, translationGroupId, sectionId]);

  useImperativeHandle(
    ref,
    () => ({
      save() {
        return new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const timer = window.setTimeout(() => {
            pending.current.delete(requestId);
            resolve({ ok: false });
          }, 8000);
          pending.current.set(requestId, (result) => {
            window.clearTimeout(timer);
            resolve(result);
          });
          post({ type: "save", requestId });
        });
      },
    }),
    [post],
  );

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
        if (Number.isFinite(next)) {
          setHeight(Math.min(FRAME_MAX_HEIGHT, Math.max(FRAME_MIN_HEIGHT, Math.ceil(next))));
        }
        return;
      }
      if (data.type === "dirty") {
        onDirty(data.dirty === true);
        return;
      }
      if (data.type === "sections") {
        onSections(parsePluginSections(data.sections));
        return;
      }
      if (data.type === "saved" && typeof data.requestId === "string") {
        const resolve = pending.current.get(data.requestId);
        if (!resolve) return;
        pending.current.delete(data.requestId);
        resolve({
          ok: data.ok === true,
          error: typeof data.error === "string" ? data.error : undefined,
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onDirty, onSections, sendContext]);

  useEffect(() => {
    if (sectionId) post({ type: "section", sectionId });
  }, [post, sectionId]);

  const src = `${item.adminAppUrl}?content=${encodeURIComponent(contentId)}&group=${encodeURIComponent(translationGroupId)}`;

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={item.label}
      className="jf-plugin-frame"
      hidden={hidden}
      style={{ height, width: "100%", border: 0 }}
      onLoad={sendContext}
      sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads allow-modals"
    />
  );
});

export default PluginContentFrame;
