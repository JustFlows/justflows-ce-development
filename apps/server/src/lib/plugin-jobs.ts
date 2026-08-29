// SPDX-License-Identifier: MIT

import { JobScheduler } from "@justflows/jobs";
import type { PluginJobsApi } from "@justflows/sdk";

let scheduler: JobScheduler | null = null;

export function getPluginJobScheduler(): JobScheduler {
  if (!scheduler) {
    scheduler = new JobScheduler({
      info: (msg, ctx) => console.info(msg, ctx ?? ""),
      warn: (msg, ctx) => console.warn(msg, ctx ?? ""),
      error: (msg, ctx) => console.error(msg, ctx ?? ""),
    });
    scheduler.start();
  }
  return scheduler;
}

export function createPluginJobsApi(pluginId: string): PluginJobsApi {
  const jobs = getPluginJobScheduler();
  return {
    register(def) {
      jobs.register({
        name: `${pluginId}:${def.name}`,
        schedule: def.schedule,
        maxAttempts: def.maxAttempts,
        handler: async (ctx) =>
          def.handler({
            jobId: ctx.jobId,
            name: def.name,
            attempt: ctx.attempt,
            scheduledAt: ctx.scheduledAt,
            payload: ctx.payload,
          }),
      });
    },
    enqueue(name, options) {
      jobs.enqueue(`${pluginId}:${name}`, options?.delayMs ?? 0, options?.payload);
    },
  };
}
