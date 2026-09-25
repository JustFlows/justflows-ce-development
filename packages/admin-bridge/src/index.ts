// SPDX-License-Identifier: MIT

/**
 * `@justflows/admin-bridge`
 *
 * A plugin's admin app (`manifest.adminApp`) runs in a same-origin `<iframe>`
 * inside the Justflows admin shell. This is the whole contract between the two:
 * a small `postMessage` protocol, no shared framework, no host globals. Import
 * it from your admin build and never reach for `window.parent` directly.
 *
 * ```ts
 * import { createAdminBridge } from "@justflows/admin-bridge";
 *
 * const bridge = createAdminBridge();
 * bridge.onContext((ctx) => renderApp(ctx));   // locale, routePath, theme, …
 * bridge.onRoute((routePath) => router.go(routePath));
 * bridge.autoResize();                          // keep the iframe sized to content
 * bridge.ready();                               // ask the host for context
 * ```
 *
 * The frame is same-origin, so read the CSRF cookie yourself and call your
 * plugin's own `ctx.http` routes for data — nothing is proxied through core.
 */

const PLUGIN_SOURCE = "justflows-admin-plugin";
const HOST_SOURCE = "justflows-admin-host";

/** Everything the host tells the plugin about where it is running. */
export interface AdminContext {
  /** Admin UI locale, e.g. `"en"` or `"nl"`. */
  locale: string;
  /** Internal admin base path, e.g. `"/admin"` (may be customised by the site). */
  adminBase: string;
  /** The admin path the frame should show right now, e.g. `"/admin/forms/submissions"`. */
  routePath: string;
  /** `"dark"`, `"light"`, or `""` when the viewer follows the system setting. */
  theme: string;
  /**
   * Locale code → catalog URL from the plugin manifest `adminApp.locales`.
   * Absent when the plugin did not declare locale files.
   */
  catalogs?: Record<string, string>;
  /**
   * Content row this frame is editing, when the host embeds the app inside the
   * content editor. Absent on a plugin's own admin screen.
   */
  contentId?: string;
  /** Translation group for that row. Defaults to `contentId` when omitted. */
  translationGroupId?: string;
  /**
   * Editor menu section the host is showing, when this frame is embedded in
   * the content editor and has published sections with `reportSections`.
   */
  sectionId?: string;
}

/** One content-editor menu entry a plugin publishes for the row it is editing. */
export interface AdminEditorSection {
  id: string;
  label: string;
}

type ContextListener = (context: AdminContext) => void;
type RouteListener = (routePath: string) => void;
type SaveListener = (requestId: string) => void;
type SectionListener = (sectionId: string) => void;

export interface AdminBridge {
  /** Tell the host the app has mounted. The host replies by delivering `context`. */
  ready(): void;
  /** The most recent context the host delivered, or `null` before the first one. */
  context(): AdminContext | null;
  /** Subscribe to context (fires on the first delivery and on any later refresh). */
  onContext(listener: ContextListener): () => void;
  /**
   * Subscribe to host-driven navigation under the plugin's own path subtree —
   * the admin URL changed and the frame's router should follow without a reload.
   */
  onRoute(listener: RouteListener): () => void;
  /**
   * The host asked this frame to persist. Call `reportSaved` when the write
   * finishes. `requestId` pairs the reply with that request.
   */
  onSave(listener: SaveListener): () => void;
  /** Reply to `onSave`. `error` is a short message the host can show. */
  reportSaved(requestId: string, ok: boolean, error?: string): void;
  /** Tell the host the frame has unsaved edits. */
  reportDirty(dirty: boolean): void;
  /**
   * Publish content-editor menu entries. The host lists them beside Content
   * and SEO and tells the frame which one is selected via `onSection`.
   */
  reportSections(sections: AdminEditorSection[]): void;
  /** The host selected one of the sections published with `reportSections`. */
  onSection(listener: SectionListener): () => void;
  /** Ask the host to navigate elsewhere (`/admin/…` path, or an absolute URL → new tab). */
  navigate(path: string): void;
  /** Report the content height so the host can size the iframe. */
  reportHeight(pixels: number): void;
  /**
   * Observe an element (default: the document element) and report its height to
   * the host whenever it changes. Returns a function that stops observing.
   */
  autoResize(element?: Element): () => void;
  /** Remove every listener and observer this bridge installed. */
  destroy(): void;
}

function currentHeight(element: Element): number {
  const rect = element.getBoundingClientRect();
  return Math.max(
    Math.ceil(rect.height),
    element.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
  );
}

export function createAdminBridge(): AdminBridge {
  const origin = window.location.origin;
  const host = window.parent;
  let context: AdminContext | null = null;
  const contextListeners = new Set<ContextListener>();
  const routeListeners = new Set<RouteListener>();
  const saveListeners = new Set<SaveListener>();
  const sectionListeners = new Set<SectionListener>();
  let resizeObserver: ResizeObserver | null = null;
  let frame = 0;

  function post(message: Record<string, unknown>): void {
    if (host && host !== window) {
      host.postMessage({ source: PLUGIN_SOURCE, ...message }, origin);
    }
  }

  function onMessage(event: MessageEvent): void {
    if (event.origin !== origin || event.source !== host) return;
    const data = event.data as {
      source?: string;
      type?: string;
      context?: unknown;
      routePath?: unknown;
      requestId?: unknown;
      sectionId?: unknown;
    };
    if (!data || data.source !== HOST_SOURCE) return;

    if (data.type === "context" && data.context && typeof data.context === "object") {
      context = data.context as AdminContext;
      for (const listener of contextListeners) listener(context);
    } else if (data.type === "save" && typeof data.requestId === "string") {
      for (const listener of saveListeners) listener(data.requestId);
    } else if (data.type === "route" && typeof data.routePath === "string") {
      const routePath = data.routePath;
      if (context) context = { ...context, routePath };
      for (const listener of routeListeners) listener(routePath);
    } else if (data.type === "section" && typeof data.sectionId === "string") {
      if (context) context = { ...context, sectionId: data.sectionId };
      for (const listener of sectionListeners) listener(data.sectionId);
    }
  }

  window.addEventListener("message", onMessage);

  return {
    ready() {
      post({ type: "ready" });
    },
    context() {
      return context;
    },
    onContext(listener) {
      contextListeners.add(listener);
      if (context) listener(context);
      return () => contextListeners.delete(listener);
    },
    onRoute(listener) {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
    onSave(listener) {
      saveListeners.add(listener);
      return () => saveListeners.delete(listener);
    },
    reportSaved(requestId, ok, error) {
      if (typeof requestId !== "string" || !requestId) return;
      post({
        type: "saved",
        requestId,
        ok: ok === true,
        ...(typeof error === "string" && error ? { error } : {}),
      });
    },
    reportDirty(dirty) {
      post({ type: "dirty", dirty: dirty === true });
    },
    reportSections(sections) {
      if (!Array.isArray(sections)) return;
      const clean = sections
        .filter((section) => section && typeof section.id === "string" && typeof section.label === "string")
        .slice(0, 12)
        .map((section) => ({ id: section.id.slice(0, 40), label: section.label.slice(0, 60) }));
      post({ type: "sections", sections: clean });
    },
    onSection(listener) {
      sectionListeners.add(listener);
      return () => sectionListeners.delete(listener);
    },
    navigate(path) {
      if (typeof path === "string" && path) post({ type: "navigate", path });
    },
    reportHeight(pixels) {
      const height = Number(pixels);
      if (Number.isFinite(height) && height > 0)
        post({ type: "resize", height: Math.ceil(height) });
    },
    autoResize(element = document.documentElement) {
      const report = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() =>
          post({ type: "resize", height: currentHeight(element) }),
        );
      };
      report();
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(report);
        resizeObserver.observe(element);
        if (document.body && document.body !== element) resizeObserver.observe(document.body);
      }
      window.addEventListener("load", report);
      return () => {
        resizeObserver?.disconnect();
        resizeObserver = null;
        window.removeEventListener("load", report);
      };
    },
    destroy() {
      window.removeEventListener("message", onMessage);
      resizeObserver?.disconnect();
      resizeObserver = null;
      contextListeners.clear();
      routeListeners.clear();
      saveListeners.clear();
      sectionListeners.clear();
      if (frame) cancelAnimationFrame(frame);
    },
  };
}
