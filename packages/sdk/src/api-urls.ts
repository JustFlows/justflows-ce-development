// SPDX-License-Identifier: MIT

/** Core owns these API namespaces; plugins cannot shadow them. */
const RESERVED = new Set("account ai analytics api-keys audit auth blocks cache cdn comment-rules comment-spam-terms comments content content-types cookies css-providers db diagnostics domains emails error-pages headers health healthz i18n import install languages manage marketplace mcp media menus oauth patterns performance platform platform-account plugins preferences redirects reusable-blocks roles search security settings signup site static-export storage template-parts templates themes trash updates users v1 webhooks".split(" "));

export function isValidPluginApiNamespace(namespace: string): boolean {
  return /^[a-z][a-z0-9-]{0,39}$/.test(namespace) && !RESERVED.has(namespace);
}

/** Build a neutral API URL. Paths are relative; query/hash suffixes are preserved. */
export function pluginApiUrl(namespace: string, path = ""): string {
  if (!isValidPluginApiNamespace(namespace)) throw new Error("Invalid or reserved plugin API namespace");
  if (path.startsWith("/") || /[\\\s\x00-\x1f]/.test(path)) throw new Error("Plugin API paths must be relative");
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  for (const part of pathname.split("/")) {
    const decoded = decodeURIComponent(part);
    if (decoded === "." || decoded === ".." || /[\\/]/.test(decoded)) throw new Error("Invalid plugin API path segment");
  }
  return `/api/${namespace}${path ? `/${path}` : ""}`;
}
