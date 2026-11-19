// SPDX-License-Identifier: MIT

/**
 * Tell the on-demand static export about a change. Cheap when on-demand mode
 * is off: the export modules are only loaded when `STATIC_EXPORT_MODE` is
 * `on-demand`, so content, comment and cache code can call this on every write.
 * A failure is logged and never breaks the write that triggered it.
 */
export async function notifyOnDemand(
  change: (onDemand: typeof import("./serve-on-demand.js")) => Promise<unknown>,
): Promise<void> {
  if (process.env.STATIC_EXPORT_MODE?.trim().toLowerCase() !== "on-demand") return;
  try {
    await change(await import("./serve-on-demand.js"));
  } catch (err) {
    console.error(
      "[justflows] static-export on-demand: could not mark pages stale:",
      err instanceof Error ? err.message.replace(/[\r\n]/g, " ") : "unknown error",
    );
  }
}
