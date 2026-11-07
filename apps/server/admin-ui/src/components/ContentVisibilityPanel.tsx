// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import type { ContentVisibilityPolicy } from "@justflows/content";
import { useT } from "../i18n/I18nProvider";
import ContentVisibilityFields, { useVisibilityDirectory } from "./ContentVisibilityFields";

interface Decision {
  allowed: boolean;
  reason: string;
  decidedBy: string;
  ruleId?: string;
  source: "default" | "type" | "item";
}

const BLANK: ContentVisibilityPolicy = {
  audience: "everyone",
  allowRoles: [],
  denyRoles: [],
  allowUsers: [],
  denyUsers: [],
  rules: [],
};

/** Saved on its own: an override is not part of the entry's revisions or its draft. */
export default function ContentVisibilityPanel({ contentId, disabled }: { contentId: string; disabled: boolean }) {
  const { t } = useT();
  const { roles, people } = useVisibilityDirectory();
  const [loaded, setLoaded] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [override, setOverride] = useState<ContentVisibilityPolicy | null>(null);
  const [typeDefault, setTypeDefault] = useState<ContentVisibilityPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"anonymous" | "role" | "user">("anonymous");
  const [subject, setSubject] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const res = await fetch(`/api/content-visibility/content/${contentId}`);
        if (cancelled) return;
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) throw new Error("load");
        const body = (await res.json()) as { override: ContentVisibilityPolicy | null; typeDefault: ContentVisibilityPolicy | null };
        if (cancelled) return;
        setOverride(body.override);
        setTypeDefault(body.typeDefault);
        setLoaded(true);
      } catch {
        if (!cancelled) setError(t("visibility.loadError"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contentId, t]);

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch(`/api/content-visibility/content/${contentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ override }),
      });
      if (!res.ok) throw new Error("save");
      setMessage(t("visibility.saved"));
      setDecision(null);
    } catch {
      setError(t("visibility.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function explain() {
    setBusy(true);
    setError("");
    setDecision(null);
    try {
      const viewer = kind === "anonymous" ? { kind } : kind === "role" ? { kind, role: subject.trim() } : { kind, userId: subject.trim() };
      const res = await fetch(`/api/content-visibility/content/${contentId}/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(viewer),
      });
      if (!res.ok) throw new Error("explain");
      setDecision(((await res.json()) as { decision: Decision }).decision);
    } catch {
      setError(t("visibility.explainError"));
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) return null;
  const knownReason = decision ? t(`visibility.reasons.${decision.reason}`) : "";
  const reason =
    decision && decision.ruleId && knownReason === `visibility.reasons.${decision.reason}`
      ? t("visibility.pluginReason", { rule: decision.ruleId, reason: decision.reason })
      : knownReason;

  return (
    <>
      <div className="jf-card">
        <div className="jf-card__head">
          <h2 className="jf-card__title">{t("visibility.itemTitle")}</h2>
        </div>
        <div className="jf-card__body jf-stack">
          <p className="jf-field__hint" style={{ margin: 0 }}>{t("visibility.itemHint")}</p>
          {error && <p className="jf-alert jf-alert--error" role="alert">{error}</p>}
          {loaded && (
            <>
              <div className="jf-field" role="radiogroup" aria-label={t("visibility.itemTitle")}>
                <label className="jf-checkrow">
                  <input type="radio" name="jf-visibility-mode" checked={override === null} disabled={disabled || busy} onChange={() => setOverride(null)} />
                  {t("visibility.modeInherit")}
                </label>
                <label className="jf-checkrow">
                  <input type="radio" name="jf-visibility-mode" checked={override !== null} disabled={disabled || busy} onChange={() => setOverride(typeDefault ?? BLANK)} />
                  {t("visibility.modeCustom")}
                </label>
                {override === null && (
                  <span className="jf-field__hint">{t(typeDefault ? "visibility.inheritedRestricted" : "visibility.inheritedPublic")}</span>
                )}
              </div>
              {override !== null && <ContentVisibilityFields idPrefix="item-visibility" policy={override} onChange={(next) => setOverride(next ?? BLANK)} />}
              {message && <p className="jf-alert jf-alert--success" role="status">{message}</p>}
              <button type="button" className="jf-btn jf-btn--primary jf-btn--block" disabled={disabled || busy} onClick={() => void save()}>
                {t("visibility.save")}
              </button>
            </>
          )}
        </div>
      </div>

      {loaded && (
        <div className="jf-card">
          <div className="jf-card__head">
            <h2 className="jf-card__title">{t("visibility.explainTitle")}</h2>
          </div>
          <div className="jf-card__body jf-stack">
            <div className="jf-field">
              <label className="jf-field__label" htmlFor="item-visibility-explain">
                {t("visibility.explainAs")}
              </label>
              <select
                id="item-visibility-explain"
                className="jf-input"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  setSubject("");
                  setDecision(null);
                }}
              >
                {(["anonymous", "role", "user"] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`visibility.explainKinds.${value}`)}
                  </option>
                ))}
              </select>
              <span className="jf-field__hint">{t("visibility.explainSaved")}</span>
            </div>
            {kind !== "anonymous" && (
              <div className="jf-field">
                {kind === "role" || people ? (
                  <select
                    className="jf-input"
                    aria-label={t(`visibility.explainKinds.${kind}`)}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  >
                    <option value="" />
                    {(kind === "role" ? roles : (people ?? [])).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="jf-input"
                    aria-label={t(`visibility.explainKinds.${kind}`)}
                    placeholder={t("visibility.userIdPlaceholder")}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                )}
              </div>
            )}
            <button
              type="button"
              className="jf-btn jf-btn--ghost jf-btn--block"
              disabled={busy || (kind !== "anonymous" && !subject.trim())}
              onClick={() => void explain()}
            >
              {t("visibility.explainRun")}
            </button>
            {decision && (
              <div className="jf-field" role="status">
                <span>
                  <span className={`jf-badge ${decision.allowed ? "jf-badge--ok" : "jf-badge--error"}`}>
                    {t(decision.allowed ? "visibility.allowed" : "visibility.denied")}
                  </span>
                </span>
                <span className="jf-field__hint">
                  {reason} {t(`visibility.sources.${decision.source}`)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
