// SPDX-License-Identifier: MIT

import type { CacheRevalidatedEvent, CacheRevalidateTrigger, ContentRef } from "@justflows/sdk";
import { getRuntimeHooks } from "../plugins/plugin-runtime.js";
import { getTenantContext } from "../tenancy/context.js";
import { getStaticExportConfig } from "./config.js";
import { runStaticExport } from "./index.js";
import { isCurrentSiteStaticExportEnabled } from "./site-enabled.js";

type Unsubscribe = () => void;

let disposers: Unsubscribe[] = [];
let armed = false;

/**
 * Pending work for one site. Revalidations from different sites must never be
 * coalesced into one run: each site rebuilds into its own export folder. The
 * timer is scheduled from the site's own request context, which the callback
 * inherits (tenant + database), so the run targets that site.
 */
interface SiteQueue {
  timer: NodeJS.Timeout | null;
  running: boolean;
  triggers: Set<CacheRevalidateTrigger>;
  contentIds: Set<string>;
  groupIds: Set<string>;
}

const queues = new Map<string, SiteQueue>();

function currentQueue(): SiteQueue {
  const key = getTenantContext()?.siteId ?? "";
  let queue = queues.get(key);
  if (!queue) {
    queue = { timer: null, running: false, triggers: new Set(), contentIds: new Set(), groupIds: new Set() };
    queues.set(key, queue);
  }
  return queue;
}

/** Strip CR/LF so crawled URLs in exporter output cannot forge log lines
 *  (CodeQL js/log-injection only accepts an empty replacement as a sanitizer). */
function stripNewlines(value: string): string {
  return value.replace(/\r/g, "").replace(/\n/g, "");
}

function logLine(line: string): void {
  const host = getTenantContext()?.hostname;
  console.log(`[justflows] static-export ${host ? `${stripNewlines(host)} ` : ""}${stripNewlines(line)}`);
}

async function flush(queue: SiteQueue): Promise<void> {
  queue.timer = null;
  if (queue.running) {
    // A run is in progress; re-arm so the events that arrived meanwhile are honoured.
    schedule(queue, getStaticExportConfig().debounceMs);
    return;
  }
  const triggers = [...queue.triggers];
  const contentIds = [...queue.contentIds];
  const translationGroupIds = [...queue.groupIds];
  queue.triggers = new Set();
  queue.contentIds = new Set();
  queue.groupIds = new Set();
  if (triggers.length === 0) return;

  queue.running = true;
  try {
    if (!(await isCurrentSiteStaticExportEnabled())) return;
    const globalTrigger = triggers.find((t) => t !== "content");
    // A non-content trigger means chrome changed → rebuild everything. Otherwise
    // use the content ids we captured so the run stays targeted.
    const trigger: CacheRevalidateTrigger = globalTrigger ?? "content";
    const summary = await runStaticExport({
      mode: "incremental",
      trigger,
      contentIds: globalTrigger ? undefined : contentIds,
      translationGroupIds: globalTrigger ? undefined : translationGroupIds,
      reason: `auto: ${triggers.join(", ")}`,
      log: (l) => logLine(l),
    });
    logLine(
      `rebuild done (${summary.pages} pages, ${summary.assets} assets` +
        `${summary.pruned ? `, ${summary.pruned} pruned` : ""})`,
    );
  } catch (err) {
    logLine(`rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    queue.running = false;
    if (queue.triggers.size > 0) schedule(queue, getStaticExportConfig().debounceMs);
  }
}

function schedule(queue: SiteQueue, delayMs: number): void {
  if (queue.timer) clearTimeout(queue.timer);
  const timer = setTimeout(() => void flush(queue), delayMs);
  if (typeof timer.unref === "function") timer.unref();
  queue.timer = timer;
}

function teardown(): void {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // ignore
    }
  }
  disposers = [];
  for (const queue of queues.values()) {
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
  }
  armed = false;
}

/**
 * (Re)arm the auto-rebuild from the current environment. When
 * `STATIC_EXPORT_AUTO=1`, an incremental export runs shortly after any
 * `cache.revalidated` action (publish / unpublish / delete / settings / menu /
 * theme) — needs cache revalidation enabled, since that is what fires the hook.
 * Safe to call repeatedly: existing listeners are dropped first, so toggling the
 * setting in the admin takes effect without a restart.
 */
export function refreshStaticExportAutoRebuild(): void {
  teardown();
  const cfg = getStaticExportConfig();
  if (!cfg.enabled) return;
  if (cfg.mode === "on-demand") {
    armOnDemand();
    return;
  }
  if (!cfg.auto) return;

  const hooks = getRuntimeHooks();
  const remember = (apply: (queue: SiteQueue) => void) => {
    void isCurrentSiteStaticExportEnabled()
      .then((allowed) => {
        if (!allowed) return;
        const queue = currentQueue();
        apply(queue);
        schedule(queue, cfg.debounceMs);
      })
      .catch(() => undefined);
  };
  disposers.push(
    hooks.action("cache.revalidated", (event: CacheRevalidatedEvent) => {
      void remember((queue) => {
        queue.triggers.add(event.trigger);
      });
    }),
  );
  // Capture the specific ids so a content change can stay a targeted rebuild.
  const noteContent = (event: ContentRef) => {
    void remember((queue) => {
      if (event.contentId) queue.contentIds.add(event.contentId);
      if (event.translationGroupId) queue.groupIds.add(event.translationGroupId);
      queue.triggers.add("content");
    });
  };
  for (const hook of ["content.published", "content.unpublished", "content.deleted"] as const) {
    disposers.push(hooks.action(hook, noteContent));
  }
  armed = true;
  console.log(
    `[justflows] static-export auto-rebuild armed (debounce ${cfg.debounceMs}ms, ` +
      `dir ${stripNewlines(cfg.outDir)})`,
  );
}

/**
 * On-demand mode: publishing, unpublishing and deleting an entry only mark
 * files stale (or remove the entry's own files). Nothing renders until a
 * visit, so the auto-rebuild stays off.
 */
function armOnDemand(): void {
  const hooks = getRuntimeHooks();
  const kinds = {
    "content.published": "published",
    "content.updated": "updated",
    "content.unpublished": "unpublished",
    "content.deleted": "deleted",
  } as const;
  for (const [hook, kind] of Object.entries(kinds) as Array<[keyof typeof kinds, (typeof kinds)[keyof typeof kinds]]>) {
    disposers.push(
      hooks.action(hook, (event: ContentRef) => {
        void import("./serve-on-demand.js")
          .then(({ noteOnDemandContentChange }) =>
            noteOnDemandContentChange(kind, {
              contentId: event.contentId,
              translationGroupId: event.translationGroupId,
              siteId: event.siteId,
            }),
          )
          .catch((err: unknown) =>
            logLine(`could not mark pages stale: ${err instanceof Error ? err.message : String(err)}`),
          );
      }),
    );
  }
  /** A comment that is approved on arrival changes its entry's page. */
  disposers.push(
    hooks.action("comments.created", (event: { siteId: string; contentId: string; status: string }) => {
      if (event.status !== "approved") return;
      void import("./serve-on-demand.js")
        .then(({ noteOnDemandCommentChange }) =>
          noteOnDemandCommentChange({ contentIds: [event.contentId], siteId: event.siteId }),
        )
        .catch((err: unknown) =>
          logLine(`could not mark pages stale: ${err instanceof Error ? err.message : String(err)}`),
        );
    }),
  );
  console.log("[justflows] static-export on-demand: stale marking armed");
}

/** Boot-time entry point (called once from register-routes). */
export function installStaticExportAutoRebuild(): void {
  refreshStaticExportAutoRebuild();
}

export function isStaticExportAutoArmed(): boolean {
  return armed;
}
