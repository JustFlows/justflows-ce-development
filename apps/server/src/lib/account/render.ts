// SPDX-License-Identifier: MIT

import ejs from "ejs";
import path from "node:path";
import type { SessionPayload } from "../auth/session.js";
import { viewsDir } from "../runtime/jf-root.js";
import { accountView } from "./view.js";

/** Hydrate only on an authenticated account-type page, never in public block previews. */
export async function renderAccountBlocks(html: string, session: SessionPayload): Promise<string> {
  if (!html.includes("data-jf-account=")) return html;
  const view = await accountView(session);
  const seen = new Set<string>();
  const fragments = new Map<string, string>();
  for (const section of view.sections) {
    fragments.set(section.id, await ejs.renderFile(path.join(viewsDir(), "account-sections.ejs"), { ...view, sections: [section] }));
  }
  const controls = '<p id="account-message" role="status" aria-live="polite"></p><button id="sign-out" type="button">Sign out</button>';
  const rendered = html.replace(/<div\b([^>]*\bdata-jf-account="(all|controls|profile|plugins|workspaces)"[^>]*)>[^<]*<\/div>/g,
    (_whole, attributes: string, kind: string) => {
      const id = /data-section-id="([a-z0-9._-]*)"/.exec(attributes)?.[1] ?? "";
      const titles = /data-show-titles="(true|false)"/.exec(attributes)?.[1] ?? "true";
      const keys = kind === "all" ? ["controls", ...fragments.keys()] : kind === "plugins"
        ? [...fragments.keys()].filter(key => key !== "profile" && key !== "workspaces" && (!id || key === id)) : [kind];
      let inner = "";
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        inner += key === "controls" ? controls : fragments.get(key) ?? "";
      }
      if (!inner.trim()) return "";
      if (titles === "false") inner = inner.replace(/<h2>[^<]*<\/h2>/g, "");
      return `<div${attributes}>${inner}</div>`;
    });
  return rendered + `<script id="initial-account" type="application/json">${view.initialAccount}</script>`;
}
