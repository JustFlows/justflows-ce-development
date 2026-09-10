// SPDX-License-Identifier: GPL-2.0-or-later
import type { PluginContext, SearchBackend, Unsubscribe } from "@justflows/sdk";

/** Optional example: add content:read to your manifest before calling this. */
export function registerSearchBackend(ctx: PluginContext, engine: SearchBackend): Unsubscribe {
  if (!ctx.permissions.has("content:read")) throw new Error("Search requires content:read");
  return ctx.hooks.filter("search.backend", (current) => current ?? engine);
}
