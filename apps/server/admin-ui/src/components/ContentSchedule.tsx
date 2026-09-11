// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { useT } from "../i18n/I18nProvider";
import { useCapability } from "./SessionProvider";

export function localDateInput(iso: string | null | undefined, utc = false): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (utc) return date.toISOString().slice(0, 16);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function localDateIso(value: string, utc = false): string | null {
  if (!value) return null;
  const date = new Date(utc ? `${value}Z` : value);
  if (!Number.isFinite(date.getTime()) || localDateInput(date.toISOString(), utc) !== value)
    throw new Error("Invalid local time");
  return date.toISOString();
}

interface ScheduleContent {
  id: string;
  version?: number;
  publishOn?: string | null;
  unpublishOn?: string | null;
}
export default function ContentSchedule<T extends ScheduleContent>({
  item,
  disabled,
  siteTimezone,
  onSaved,
}: {
  item: T;
  disabled: boolean;
  siteTimezone: string;
  onSaved: (item: T) => void;
}) {
  const { t, locale } = useT();
  const canPublish = useCapability("content:publish");
  const [publishOn, setPublishOn] = useState("");
  const [unpublishOn, setUnpublishOn] = useState("");
  const [utc, setUtc] = useState(false);
  const [zone, setZone] = useState("UTC");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewLink, setPreviewLink] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    setPublishOn(localDateInput(item.publishOn, utc));
    setUnpublishOn(localDateInput(item.unpublishOn, utc));
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, [item.id, item.publishOn, item.unpublishOn]);
  const siteTime = (value: string) => {
    try {
      const iso = localDateIso(value, utc);
      return iso
        ? new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "long",
            timeZone: siteTimezone,
          }).format(new Date(iso))
        : "";
    } catch {
      return t("scheduling.invalidTime");
    }
  };
  async function submit(cancel = false) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let dates;
      try {
        dates = {
          publishOn: cancel ? null : localDateIso(publishOn, utc),
          unpublishOn: cancel ? null : localDateIso(unpublishOn, utc),
        };
      } catch {
        throw new Error(t("scheduling.invalidTime"));
      }
      const response = await fetch(`/api/content/${item.id}/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...dates, expectedVersion: item.version }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? t("scheduling.error"));
      onSaved(body);
      setMessage(t(cancel ? "scheduling.cancelled" : "scheduling.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("scheduling.error"));
    } finally {
      setBusy(false);
    }
  }
  async function sharePreview() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/content/${item.id}/preview-link`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? t("scheduling.error"));
      setPreviewLink(new URL(body.url, window.location.origin).href);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("scheduling.error"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset
      disabled={disabled || busy || !canPublish}
      style={{ border: 0, padding: 0, minWidth: 0 }}
    >
      <legend className="jf-field__label">{t("scheduling.title")}</legend>
      <p className="jf-field__hint">
        {t("scheduling.zones", { site: siteTimezone, user: utc ? "UTC" : zone })}
      </p>
      <label className="jf-field">
        <span className="jf-field__label">{t("scheduling.timezone")}</span>
        <select
          className="jf-input"
          value={utc ? "UTC" : "local"}
          onChange={(event) => {
            const nextUtc = event.target.value === "UTC";
            try {
              setPublishOn(localDateInput(localDateIso(publishOn, utc), nextUtc));
              setUnpublishOn(localDateInput(localDateIso(unpublishOn, utc), nextUtc));
              setUtc(nextUtc);
            } catch {
              setError(t("scheduling.invalidTime"));
            }
          }}
        >
          <option value="local">{zone}</option>
          <option value="UTC">UTC</option>
        </select>
      </label>
      <p className="jf-field__hint">{t("scheduling.savedDraft")}</p>
      {disabled && <p className="jf-field__hint">{t("scheduling.saveFirst")}</p>}
      <label className="jf-field">
        <span className="jf-field__label">{t("scheduling.publishOn")}</span>
        <input
          className="jf-input"
          type="datetime-local"
          value={publishOn}
          onChange={(e) => setPublishOn(e.target.value)}
        />
        {publishOn && <span className="jf-field__hint">{siteTime(publishOn)}</span>}
      </label>
      <label className="jf-field">
        <span className="jf-field__label">{t("scheduling.unpublishOn")}</span>
        <input
          className="jf-input"
          type="datetime-local"
          value={unpublishOn}
          onChange={(e) => setUnpublishOn(e.target.value)}
        />
        {unpublishOn && <span className="jf-field__hint">{siteTime(unpublishOn)}</span>}
      </label>
      <button type="button" className="jf-btn jf-btn--secondary" onClick={() => void submit()}>
        {t("scheduling.save")}
      </button>
      {(item.publishOn || item.unpublishOn) && (
        <button type="button" className="jf-btn jf-btn--ghost" onClick={() => void submit(true)}>
          {t("scheduling.cancel")}
        </button>
      )}
      <button type="button" className="jf-btn jf-btn--ghost" onClick={() => void sharePreview()}>
        {t("scheduling.sharePreview")}
      </button>
      {previewLink && (
        <label className="jf-field">
          <span className="jf-field__label">{t("scheduling.previewReady")}</span>
          <input
            className="jf-input"
            readOnly
            value={previewLink}
            onFocus={(event) => event.target.select()}
          />
        </label>
      )}
      {error && (
        <p className="jf-alert jf-alert--error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
