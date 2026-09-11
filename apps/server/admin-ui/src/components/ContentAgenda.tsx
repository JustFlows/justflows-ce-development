// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { Link } from "../admin-router";
import { useT } from "../i18n/I18nProvider";

interface AgendaItem {
  id: string;
  title: string;
  locale: string;
  publishOn: string | null;
  unpublishOn: string | null;
}
export default function ContentAgenda({
  type,
  locale: contentLocale,
}: {
  type: string;
  locale: string | null;
}) {
  const { t, locale } = useT();
  const [selectedLocale, setSelectedLocale] = useState(contentLocale ?? "");
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setItems([]);
    void (async () => {
      const result: AgendaItem[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ status: "scheduled", limit: "100" });
        if (type !== "all") params.set("type", type);
        if (selectedLocale) params.set("locale", selectedLocale);
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/content?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const body = await response.json();
        result.push(...body.items);
        cursor = body.nextCursor ?? null;
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setItems(result);
    })()
      .catch(() => {
        if (!controller.signal.aborted) setError(t("scheduling.error"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [type, selectedLocale, refresh, t]);
  const events = items
    .flatMap((item) => [
      ...(item.publishOn ? [{ item, at: item.publishOn, action: "scheduling.publishOn" }] : []),
      ...(item.unpublishOn
        ? [{ item, at: item.unpublishOn, action: "scheduling.unpublishOn" }]
        : []),
    ])
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return (
    <section className="jf-card" aria-label={t("scheduling.agenda")}>
      <div className="jf-card__head">
        <h2>{t("scheduling.agenda")}</h2>
        <button
          className="jf-btn jf-btn--ghost"
          disabled={busy}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t("scheduling.refresh")}
        </button>
      </div>
      <div className="jf-card__body">
        <label className="jf-field">
          <span className="jf-field__label">{t("scheduling.localeFilter")}</span>
          <input
            className="jf-input"
            value={selectedLocale}
            placeholder="en-US"
            onChange={(event) => setSelectedLocale(event.target.value)}
          />
        </label>
        {busy && <p role="status">{t("scheduling.loading")}</p>}
        {error && <p role="alert">{error}</p>}
        {!busy && !error && !events.length && <p>{t("scheduling.empty")}</p>}
        <ol>
          {events.map(({ item, at, action }) => (
            <li key={`${item.id}:${action}`} style={{ marginBottom: "1rem" }}>
              <time dateTime={at}>
                {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "long" }).format(
                  new Date(at),
                )}
              </time>
              {" · "}
              {t(action)}
              {" · "}
              <Link to={`/admin/content/${item.id}`}>{item.title}</Link>
              {" · "}
              {item.locale}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
