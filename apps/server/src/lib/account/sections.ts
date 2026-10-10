// SPDX-License-Identifier: MIT

import { accountProfile } from "./profile.js";
import type { AccountSection, AccountSectionContext } from "@justflows/sdk";
import { ensurePluginRuntime, getRuntimeHooks } from "../plugins/plugin-runtime.js";

const text = (value: unknown, max = 2000): string => typeof value === "string" ? value.slice(0, max) : "";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown, max: number): unknown[] => Array.isArray(value) ? value.slice(0, max) : [];

function link(value: unknown): string {
  const href = text(value, 2000);
  if (!href || /[\\\s\x00-\x1f]/.test(href)) return "";
  if (href.startsWith("/") && !href.startsWith("//")) {
    const url = new URL(href, "https://account.invalid");
    return url.pathname + url.search + url.hash;
  }
  try { const url = new URL(href); if (url.protocol === "https:" && !url.username && !url.password) return url.href; } catch { /* Invalid link. */ }
  return "";
}

/** Bound extension output and exclude executable URLs and duplicate/reserved anchors. */
export function sanitizeAccountSections(raw: unknown): AccountSection[] {
  const seen = new Set(["account-content", "account-message", "initial-account", "workspace-select", "workspace-status",
    "workspace-details", "workspace-name-form", "workspace-name", "workspace-id", "site-list", "show-new-site",
    "new-site-form", "site-domain", "cancel-new-site", "resource-select", "resource-list", "sign-out"]);
  const sections: AccountSection[] = [];
  for (const value of list(raw, 50)) {
    const row = record(value); const id = text(row.id, 120); const title = text(row.title, 160);
    if (!/^[a-z][a-z0-9._-]*$/.test(id) || !title || seen.has(id)) continue;
    seen.add(id);
    sections.push({ id, title, description: text(row.description), cards: list(row.cards, 100).map((value) => {
      const card = record(value);
      return {
        title: text(card.title, 160),
        fields: list(card.fields, 100).map((value) => { const field = record(value); return { label: text(field.label, 160), value: text(field.value) }; }),
        links: list(card.links, 20).flatMap((value) => { const row = record(value); const href = link(row.href); const label = text(row.label, 160); return href && label ? [{ href, label }] : []; }),
        actions: list(card.actions, 20).flatMap((value) => {
          const row = record(value); const endpoint = link(row.endpoint); const label = text(row.label, 160);
          // Actions stay on the authenticated account surface; URLs cannot smuggle a new origin.
          return label && /^\/(?:api\/(?:account\/|[a-z0-9-]+\/account\/)|ext\/[a-z0-9._-]+\/account\/)[^?#]+$/.test(endpoint)
            ? [{ label, endpoint, confirm: text(row.confirm) }] : [];
        }),
      };
    }) });
  }
  return sections;
}

export async function accountSections(context: AccountSectionContext): Promise<AccountSection[]> {
  const claims = Object.freeze({ ...context });
  const [profile] = await Promise.all([accountProfile(claims.siteId, claims.userId), ensurePluginRuntime()]);
  const core: AccountSection[] = [{ id: "profile", title: "Your profile", cards: [{ title: "Account details", fields: [
    { label: "Email", value: claims.email },
    ...(profile ? [{ label: "Name", value: profile.display_name }, { label: "Username", value: profile.username }] : []),
    { label: "Role", value: claims.role },
  ] }] }];
  if (claims.installationRoot) core.push({ id: "workspaces", title: "Your workspaces", cards: [] });
  const raw = await getRuntimeHooks().applyFilter("account.sections", core, claims, Object.freeze({
    siteId: claims.siteId, source: "http", actor: Object.freeze({ userId: claims.userId, role: claims.role }),
  }));
  return sanitizeAccountSections(raw);
}
