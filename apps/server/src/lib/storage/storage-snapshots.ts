// SPDX-License-Identifier: MIT
import {
  getPlatformStorageUsage,
  getSiteStorageUsage,
  type StorageUsageReport,
} from "./storage-usage.js";
interface Snapshot {
  state: "measuring" | "ready" | "unavailable";
  report: StorageUsageReport | null;
  checkedAt: number;
  invalidated?: boolean;
}
const snapshots = new Map<string, Snapshot>();
export function storageSnapshot(siteId?: string): Snapshot {
  const key = siteId ?? "platform";
  let snapshot = snapshots.get(key);
  if (!snapshot || (snapshot.state !== "measuring" && Date.now() - snapshot.checkedAt > 60_000)) {
    if (!snapshots.has(key) && snapshots.size >= 200) {
      const old = [...snapshots].find(([, item]) => item.state !== "measuring");
      if (old) snapshots.delete(old[0]);
    }
    snapshot = { state: "measuring", report: snapshot?.report ?? null, checkedAt: Date.now() };
    snapshots.set(key, snapshot);
    const current = snapshot;
    void (siteId ? getSiteStorageUsage(siteId) : getPlatformStorageUsage())
      .then((report) => {
        current.report = report;
        current.state = report.totalBytes === null ? "unavailable" : "ready";
      })
      .catch(() => {
        current.state = "unavailable";
        current.report = null;
      })
      .finally(() => {
        current.checkedAt = current.invalidated ? 0 : Date.now();
      });
  }
  return snapshot;
}
export function invalidateStorageSnapshots(siteId: string): void {
  for (const key of [siteId, "platform"]) {
    const snapshot = snapshots.get(key);
    if (snapshot?.state === "measuring") snapshot.invalidated = true;
    else if (snapshot) snapshot.checkedAt = 0;
  }
}
