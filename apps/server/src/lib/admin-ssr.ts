// SPDX-License-Identifier: MIT

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Request, Response } from "express";
import { getJfRoot } from "./jf-root.js";
import { logSafe } from "./log-safe.js";

interface SerializedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface AdminSsrPayload {
  url: string;
  locale: string;
  responses: Record<string, SerializedResponse>;
}

type RenderAdmin = (url: string, payload: AdminSsrPayload) => string;

const ADMIN_LOCALES = ["en", "nl", "de", "fr", "es"] as const;
const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

function adminUiDist(): string {
  const root = getJfRoot();
  const candidates = [
    path.join(root, "apps/server/admin-ui/dist"),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../admin-ui/dist"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

export function adminClientDir(): string {
  return path.join(adminUiDist(), "client");
}

export function adminClientIndex(): string {
  return path.join(adminClientDir(), "index.html");
}

function adminServerEntry(): string {
  return path.join(adminUiDist(), "server", "entry-server.js");
}

export function serializeAdminSsrData(value: unknown): string {
  return JSON.stringify(value).replace(
    SCRIPT_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function preferredLocale(req: Request): string {
  const cookieLocale =
    typeof req.cookies?.jf_locale === "string" ? (req.cookies.jf_locale.split("-")[0] ?? "") : "";
  if ((ADMIN_LOCALES as readonly string[]).includes(cookieLocale)) return cookieLocale;
  const language = req.acceptsLanguages(...ADMIN_LOCALES);
  return typeof language === "string" ? language : "en";
}

export function adminPrefetchPaths(originalUrl: string): string[] {
  const url = new URL(originalUrl, "http://justflows.local");
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  const paths = new Set<string>([
    "/api/site/identity",
    "/api/updates",
    "/api/plugins/admin-menu",
    "/api/auth/me",
    ...ADMIN_LOCALES.map((locale) => `/api/i18n/${locale}`),
  ]);
  if (url.searchParams.get("preview") === "1") paths.add("/api/site/identity?preview=1");

  if (pathname === "/admin") return [...paths];
  if (pathname === "/admin/content") {
    paths.add("/api/languages");
    paths.add("/api/settings");
    paths.add("/api/content-types");
  } else if (pathname === "/admin/content/new") {
    const type = url.searchParams.get("type") ?? "post";
    paths.add("/api/languages/active");
    paths.add(`/api/content-types/${encodeURIComponent(type)}`);
  } else if (/^\/admin\/content\/[^/]+\/builder$/.test(pathname)) {
    const id = pathname.split("/")[3]!;
    paths.add(`/api/content/${encodeURIComponent(id)}`);
    paths.add("/api/blocks");
    paths.add("/api/menus");
    paths.add("/api/header-presets");
    paths.add("/api/reusable-blocks");
    paths.add("/api/themes/patterns");
  } else if (/^\/admin\/content\/[^/]+$/.test(pathname)) {
    const id = pathname.split("/")[3]!;
    paths.add("/api/languages/active");
    paths.add("/api/settings");
    paths.add(`/api/content/${encodeURIComponent(id)}`);
  } else if (pathname === "/admin/content-types") {
    paths.add("/api/content-types");
  } else if (pathname === "/admin/media") {
    paths.add("/api/media");
  } else if (pathname === "/admin/plugins") {
    paths.add("/api/plugins");
  } else if (/^\/admin\/plugins\/[^/]+\/settings$/.test(pathname)) {
    const id = pathname.split("/")[3]!;
    paths.add(`/api/plugins/${encodeURIComponent(id)}/settings`);
  } else if (pathname === "/admin/analytics") {
    paths.add("/api/analytics");
  } else if (pathname === "/admin/forms") {
    paths.add("/api/forms");
  } else if (pathname === "/admin/themes") {
    paths.add("/api/themes");
  } else if (pathname === "/admin/themes/customize") {
    paths.add("/api/template-parts/footer");
    paths.add("/api/languages/active");
    paths.add("/api/themes/customize");
  } else if (pathname === "/admin/design") {
    paths.add("/api/css-providers");
  } else if (pathname === "/admin/menus") {
    paths.add("/api/menus");
    paths.add("/api/languages");
    paths.add("/api/content-types");
  } else if (pathname === "/admin/users") {
    paths.add("/api/users");
  } else if (pathname === "/admin/settings") {
    paths.add("/api/settings");
  } else if (pathname === "/admin/comments") {
    paths.add("/api/comments?status=pending");
  } else if (pathname === "/admin/marketplace") {
    paths.add("/api/marketplace");
    paths.add("/api/plugins");
    paths.add("/api/themes");
  } else if (pathname === "/admin/tools") {
    paths.add("/api/performance/settings");
    paths.add("/api/cache/settings");
    paths.add("/api/performance/stats");
    paths.add("/api/cache/stats");
  } else if (pathname === "/admin/health") {
    paths.add("/api/health");
  } else if (pathname === "/admin/languages") {
    paths.add("/api/languages");
  } else if (
    pathname === "/admin/security" ||
    pathname === "/admin/security/headers" ||
    pathname === "/admin/security/advanced"
  ) {
    paths.add("/api/security/headers");
  } else if (pathname === "/admin/security/account") {
    paths.add("/api/auth/2fa");
  } else if (pathname === "/admin/security/audit") {
    paths.add("/api/audit");
  }
  return [...paths];
}

async function fetchOne(
  origin: string,
  requestPath: string,
  cookie: string,
): Promise<SerializedResponse> {
  const response = await fetch(new URL(requestPath, origin), {
    headers: { accept: "application/json", cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const headers: Record<string, string> = {};
  const contentType = response.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text(),
  };
}

async function addDerivedResponses(
  req: Request,
  origin: string,
  responses: Record<string, SerializedResponse>,
): Promise<void> {
  const pathname = new URL(req.originalUrl, "http://justflows.local").pathname;
  const derived = new Set<string>();
  const read = <T>(key: string): T | undefined => {
    try {
      return JSON.parse(responses[key]?.body ?? "") as T;
    } catch {
      return undefined;
    }
  };

  if (pathname === "/admin/content") {
    const langs = read<{ languages?: Array<{ code?: string; isDefault?: boolean }> }>("/api/languages");
    const defaultLocale =
      langs?.languages?.find((lang) => lang.isDefault)?.code ?? langs?.languages?.[0]?.code;
    derived.add(
      defaultLocale ? `/api/content?locale=${encodeURIComponent(defaultLocale)}` : "/api/content",
    );
  }
  if (/^\/admin\/content\/[^/]+$/.test(pathname)) {
    const id = pathname.split("/")[3]!;
    const content = read<{ type?: string; translationGroupId?: string }>(
      `/api/content/${encodeURIComponent(id)}`,
    );
    if (content?.type) derived.add(`/api/content-types/${encodeURIComponent(content.type)}`);
    if (content?.translationGroupId) {
      derived.add(
        `/api/content?translationGroupId=${encodeURIComponent(content.translationGroupId)}&limit=20`,
      );
    }
  }
  if (pathname === "/admin/menus") {
    const menus = read<{ menus?: Array<{ slug?: string }> }>("/api/menus");
    const slug = menus?.menus?.[0]?.slug;
    if (slug) derived.add(`/api/menus/${encodeURIComponent(slug)}`);
    const langs = read<{ languages?: Array<{ code?: string; isDefault?: boolean }> }>("/api/languages");
    const defaultLocale =
      langs?.languages?.find((lang) => lang.isDefault)?.code ?? langs?.languages?.[0]?.code;
    if (defaultLocale) {
      const localeQuery = `&locale=${encodeURIComponent(defaultLocale)}`;
      const types = read<{ types?: Array<{ slug?: string }> }>("/api/content-types");
      const slugs = (types?.types ?? []).map((type) => type.slug).filter((slug): slug is string => Boolean(slug));
      const list = slugs.length > 0 ? slugs : ["page", "post"];
      for (const type of list) {
        derived.add(`/api/content?type=${encodeURIComponent(type)}&status=published&limit=100${localeQuery}`);
      }
    }
  }
  if (pathname === "/admin/forms") {
    const forms = read<{ forms?: Array<{ id?: string }> }>("/api/forms");
    const id = forms?.forms?.[0]?.id;
    if (id) derived.add(`/api/forms/${encodeURIComponent(id)}/submissions`);
  }

  const cookie = req.get("cookie") ?? "";
  await Promise.all(
    [...derived].map(async (requestPath) => {
      try {
        responses[requestPath] = await fetchOne(origin, requestPath, cookie);
      } catch {
        /* client can recover */
      }
    }),
  );
}

async function buildPayload(req: Request): Promise<AdminSsrPayload> {
  const payload: AdminSsrPayload = {
    url: req.originalUrl,
    locale: preferredLocale(req),
    responses: {},
  };
  const configuredOrigin = (process.env.APP_URL ?? "").replace(/\/$/, "");
  let origin: string;
  const localPort = req.socket.localPort;
  if (Number.isInteger(localPort) && Number(localPort) > 0) {
    origin = `http://127.0.0.1:${localPort}`;
  } else {
    try {
      origin = new URL(configuredOrigin).origin;
    } catch {
      return payload;
    }
  }
  const cookie = req.get("cookie") ?? "";
  await Promise.all(
    adminPrefetchPaths(req.originalUrl).map(async (requestPath) => {
      try {
        payload.responses[requestPath] = await fetchOne(origin, requestPath, cookie);
      } catch {
        /* client can recover */
      }
    }),
  );
  await addDerivedResponses(req, origin, payload.responses);
  return payload;
}

async function loadRenderer(): Promise<RenderAdmin> {
  const entry = adminServerEntry();
  const module = (await import(pathToFileURL(entry).href)) as { render?: RenderAdmin };
  if (typeof module.render !== "function") throw new Error("Admin SSR bundle has no render export");
  return module.render;
}

export async function renderAdminPage(req: Request, res: Response): Promise<void> {
  try {
    const [template, render, payload] = await Promise.all([
      fsp.readFile(adminClientIndex(), "utf-8"),
      loadRenderer(),
      buildPayload(req),
    ]);
    const appHtml = render(req.originalUrl, payload);
    const html = template
      .replace("<!--ssr-outlet-->", appHtml)
      .replace(
        "<!--ssr-data-->",
        `<script id="jf-ssr-data" type="application/json">${serializeAdminSsrData(payload)}</script>`,
      );
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Vary", "Cookie, Accept-Language");
    res.status(200).type("html").send(html);
  } catch (err) {
    console.error("[justflows] admin SSR failed", JSON.stringify({ path: logSafe(req.path) }), err);
    res.status(503).type("text/plain").send("Admin UI is temporarily unavailable.");
  }
}
