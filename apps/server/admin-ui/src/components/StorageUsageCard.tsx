// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { useT } from "../i18n/I18nProvider";
export interface StorageUsage {
  generatedAt: string;
  rows: Array<{
    category: "media" | "private" | "exports";
    local: { bytes: number; files: number } | null;
    external: { bytes: number; files: number } | null;
  }>;
  local: { bytes: number; files: number } | null;
  external: { bytes: number; files: number } | null;
  totalBytes: number | null;
  logicalBytes: number | null;
}
export function formatStorageBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(2) : value} ${units[unit]}`;
}

export default function StorageUsageCard({
  usage: initial,
  endpoint,
  onMeasured,
  refreshKey,
}: {
  usage?: StorageUsage | null;
  endpoint: string;
  refreshKey?: string;
  onMeasured?: (usage: StorageUsage | null) => void;
}) {
  const [usage, setUsage] = useState(initial);
  const [state, setState] = useState("measuring");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error("Storage unavailable");
        const snapshot = (await response.json()) as { state: string; report: StorageUsage | null };
        if (stopped) return;
        setUsage(snapshot.report);
        onMeasured?.(snapshot.report);
        setState(snapshot.state);
        if (snapshot.state === "measuring") timer = setTimeout(() => void load(), 3000);
      } catch {
        if (!stopped) { setUsage(null); onMeasured?.(null); setState("unavailable"); }
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [endpoint, initial, refreshKey]);
  const { t } = useT();
  const amount = (bytes: number | null | undefined) =>
    bytes == null ? t("storageUsage.unknown") : formatStorageBytes(bytes);
  return (
    <section className="jf-card">
      <div className="jf-card__head">
        <h2 className="jf-card__title">{t("storageUsage.title")}</h2>
      </div>
      <div className="jf-card__body jf-stack">
        <p>{t("storageUsage.description")}</p>
        {state === "measuring" && <p role="status">{t("storageUsage.measuring")}</p>}
        {state === "unavailable" && <p role="status">{t("storageUsage.unknown")}</p>}
        <div className="jf-table-wrap">
          <table className="jf-table">
            <thead>
              <tr>
                <th>{t("storageUsage.category")}</th>
                <th>{t("storageUsage.local")}</th>
                <th>{t("storageUsage.external")}</th>
              </tr>
            </thead>
            <tbody>
              {(usage?.rows ?? []).map((row) => (
                <tr key={row.category}>
                  <td>{t(`storageUsage.${row.category}`)}</td>
                  <td>{amount(row.local?.bytes)}</td>
                  <td>{amount(row.external?.bytes)}</td>
                </tr>
              ))}
              <tr>
                <th>{t("storageUsage.total")}</th>
                <td>{amount(usage?.local?.bytes)}</td>
                <td>{amount(usage?.external?.bytes)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          {t("storageUsage.physical")}: <strong>{amount(usage?.totalBytes)}</strong> ·{" "}
          {t("storageUsage.logical")}: {amount(usage?.logicalBytes)}
        </p>
        <p className="jf-field__hint">{t("storageUsage.note")}</p>
        {usage && (
          <p className="jf-field__hint">
            {t("storageUsage.measured")}: {new Date(usage.generatedAt).toLocaleString()}
          </p>
        )}
      </div>
    </section>
  );
}
