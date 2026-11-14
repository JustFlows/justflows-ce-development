import { publicAdminPath } from "../../admin-path";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/I18nProvider";
import {
  NO_HEADER_REF,
  SITE_DEFAULT_HEADER_REF,
  type HeaderTemplateOptionDTO,
  type SiteHeaderOptionDTO,
} from "../../lib/page-header";
/** Builder-only styles load with the builder, not on every admin page (justflows-ce#310). */
import "../../styles/builder.css";

/**
 * Per-page header picker. The header itself is built in Theme builder → Header;
 * a page only chooses which library entry (or the site default, or none) it
 * renders. The choice persists on its own the moment it changes — it is page
 * chrome config, not part of the draftable blocks/Save flow.
 */
export default function HeaderRefField({
  contentId,
  value,
  onChange,
  compact = false,
}: {
  contentId: string;
  value: string;
  onChange?: (ref: string) => void;
  compact?: boolean;
}) {
  const { t } = useT();
  const [items, setItems] = useState<SiteHeaderOptionDTO[]>([]);
  const [templates, setTemplates] = useState<HeaderTemplateOptionDTO[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [current, setCurrent] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setCurrent(value), [value]);

  useEffect(() => {
    let alive = true;
    fetch("/api/headers/options")
      .then((r) => r.json())
      .then(
        (body: {
          defaultId?: string | null;
          items?: SiteHeaderOptionDTO[];
          templates?: HeaderTemplateOptionDTO[];
        }) => {
          if (!alive) return;
          setItems(body.items ?? []);
          setTemplates(body.templates ?? []);
          setDefaultId(body.defaultId ?? null);
        },
      )
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  async function choose(ref: string) {
    setCurrent(ref);
    onChange?.(ref);
    setState("saving");
    try {
      const res = await fetch(`/api/content/${contentId}/header-ref`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      if (!res.ok) throw new Error();
      setState("saved");
    } catch {
      setState("error");
    }
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setState("idle"), 1800);
  }

  const defaultName = items.find((i) => i.id === defaultId)?.name;
  const ownEntries = items.filter((i) => i.id !== defaultId);
  const select = (
    <select
      className={compact ? "jf-editor__select" : "jf-input"}
      value={current}
      onChange={(e) => void choose(e.target.value)}
      aria-label={t("builder.headerRef.headerForThisPage")}
    >
      <option value={SITE_DEFAULT_HEADER_REF}>
        {t("builder.headerRef.siteDefault")}{defaultName ? ` — ${defaultName}` : ""}
      </option>
      {ownEntries.length > 0 && (
        <optgroup label={t("builder.headerRef.yourHeaders")}>
          {ownEntries.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </optgroup>
      )}
      {templates.length > 0 && (
        <optgroup label={t("builder.headerRef.fromPlugins")}>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
              {tpl.source ? ` (${tpl.source})` : ""}
            </option>
          ))}
        </optgroup>
      )}
      <option value={NO_HEADER_REF}>{t("builder.headerRef.none")}</option>
    </select>
  );

  if (compact) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
        {select}
        {state === "saving" && <span className="jf-editor__status">{t("common.saving")}</span>}
        {state === "saved" && <span className="jf-editor__status jf-editor__status--ok">✓</span>}
        {state === "error" && <span className="jf-editor__status jf-editor__status--error">{t("builder.headerRef.failed")}</span>}
      </span>
    );
  }

  return (
    <div className="jf-field">
      <label className="jf-field__label">{t("builder.headerRef.header")}</label>
      {select}
      <p className="jf-field__hint">
        {state === "saving"
          ? t("common.saving")
          : state === "saved"
            ? t("builder.headerRef.saved")
            : state === "error"
              ? t("builder.headerRef.couldNotSave")
              : (
                <>
                  {t("builder.headerRef.appliesRightAway")}{" "}
                  <a href={publicAdminPath("/admin/themes/customize")} target="_blank" rel="noopener noreferrer">
                    {t("builder.headerRef.themeBuilderHeaderLink")}
                  </a>
                  .
                </>
              )}
      </p>
    </div>
  );
}
