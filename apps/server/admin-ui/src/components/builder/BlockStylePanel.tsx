import {
  DEVICE_BUCKETS,
  blockScopeClass,
  normalizeDeviceList,
  sanitizeBlockClassName,
  scopeBlockCss,
} from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import { useThemeStyleTokens, type ThemeStyleToken } from "../../lib/theme-style-tokens";
import type { BlockNode } from "./types";

/**
 * Per-block presentation: extra classes, and CSS confined to this block.
 *
 * The preview line below the textarea shows the CSS exactly as the server will
 * emit it, so an editor can see what `&` resolved to before they publish. The
 * "Theme variables" list shows which `--…` custom properties the active theme
 * exposes, so `& { --… : … }` overrides don't have to be guessed.
 */
export default function BlockStylePanel({
  block,
  onChange,
  part = "all",
}: {
  block: BlockNode;
  onChange: (props: Record<string, unknown>) => void;
  /** `devices`: only "Show on devices" (Responsive tab). `code`: only classes and CSS (Advanced tab). */
  part?: "all" | "devices" | "code";
}) {
  const showDevices = part !== "code";
  const showCode = part !== "devices";
  const { t } = useT();
  const { tokens } = useThemeStyleTokens();
  const props = block.props;
  const className = typeof props.className === "string" ? props.className : "";
  const css = typeof props.css === "string" ? props.css : "";
  const scope = blockScopeClass(block.id);

  function set(key: "className" | "css", value: string) {
    const next = { ...props };
    if (value.trim()) next[key] = value;
    else delete next[key];
    onChange(next);
  }

  // "Show on devices": an empty stored value means "shown everywhere".
  const devices = normalizeDeviceList(props.devices) ?? [];
  const shownOn = (d: string) => devices.length === 0 || devices.includes(d as never);
  function toggleDevice(d: string) {
    const base = devices.length === 0 ? [...DEVICE_BUCKETS] : devices;
    const nextList = base.includes(d as never)
      ? base.filter((x) => x !== d)
      : [...base, d as never];
    const normalized = normalizeDeviceList(nextList);
    const nextProps = { ...props };
    if (normalized) nextProps.devices = normalized;
    else delete nextProps.devices;
    onChange(nextProps);
  }

  /** Append `& { --name: value; }` to the CSS box (or extend a trailing `& { … }`). */
  function insertToken(token: ThemeStyleToken) {
    const value = token.presets?.[0]?.value ?? token.value;
    const decl = `${token.name}: ${value};`;
    const trimmed = css.replace(/\s+$/, "");
    const trailingBlock = /&\s*\{([^{}]*)\}\s*$/;
    const next = trailingBlock.test(trimmed)
      ? trimmed.replace(trailingBlock, (_m, body) => `& {${body.replace(/\s*$/, "")} ${decl} }`)
      : `${trimmed}${trimmed ? "\n\n" : ""}& { ${decl} }`;
    set("css", next);
  }

  const compiled = css.trim() && scope ? scopeBlockCss(css, `.${scope}`) : "";
  const rejected = Boolean(css.trim()) && !compiled;
  const strippedClasses = className.trim() && !sanitizeBlockClassName(className);

  const grouped = tokens.reduce<Record<string, ThemeStyleToken[]>>((acc, tk) => {
    (acc[tk.section] ??= []).push(tk);
    return acc;
  }, {});

  return (
    <section className="jf-block-panel" aria-labelledby={`jf-style-${block.id}`}>
      <h3 id={`jf-style-${block.id}`}>{part === "devices" ? t("builder.style.devices") : t("builder.style.title")}</h3>
      {showCode && <p className="jf-block-panel__hint">{t("builder.style.hint")}</p>}

      {showCode && <label className="jf-block-panel__field">
        {t("builder.style.className")}
        <input
          type="text"
          value={className}
          spellCheck={false}
          placeholder="hero-lead featured"
          onChange={(e) => set("className", e.target.value)}
        />
      </label>}
      {showCode && strippedClasses && (
        <p className="jf-block-panel__error">{t("builder.style.classNameInvalid")}</p>
      )}

      {showDevices && <div className="jf-block-panel__field" data-jf-field="devices">
        {part === "all" && <span>{t("builder.style.devices")}</span>}
        <div className="jf-filterbar" style={{ marginTop: "0.35rem" }}>
          {DEVICE_BUCKETS.map((d) => (
            <button
              key={d}
              type="button"
              className="jf-chip"
              aria-pressed={shownOn(d)}
              onClick={() => toggleDevice(d)}
            >
              {t(`builder.style.device.${d}`)}
            </button>
          ))}
        </div>
        <p className="jf-block-panel__hint" style={{ marginTop: "0.3rem" }}>
          {t("builder.style.devicesHint")}
        </p>
      </div>}

      {showCode && <label className="jf-block-panel__field">
        {t("builder.style.css")}
        <textarea
          rows={8}
          className="jf-block-panel__code"
          value={css}
          spellCheck={false}
          placeholder={
            "padding: 3rem 1rem;\n\n& h2 { font-size: 2.5rem }\n&:hover { background: var(--color-surface) }\n@media (max-width: 600px) { & { padding: 1rem } }"
          }
          onChange={(e) => set("css", e.target.value)}
        />
      </label>}

      {!showCode ? null : rejected ? (
        <p className="jf-block-panel__error">{t("builder.style.cssRejected")}</p>
      ) : compiled ? (
        <details className="jf-block-panel__compiled">
          <summary>{t("builder.style.compiled")}</summary>
          <pre>{compiled}</pre>
        </details>
      ) : null}

      {showCode && tokens.length > 0 && (
        <details className="jf-block-panel__compiled">
          <summary>
            {t("builder.style.tokens")} ({tokens.length})
          </summary>
          <p className="jf-block-panel__hint" style={{ margin: "0.4rem 0" }}>
            {t("builder.style.tokensHint")}
          </p>
          {Object.entries(grouped).map(([section, list]) => (
            <div key={section} style={{ marginBottom: "0.6rem" }}>
              <div
                style={{
                  fontSize: "0.68rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--jf-text-3)",
                  margin: "0.35rem 0 0.2rem",
                }}
              >
                {section}
              </div>
              {list.map((tk) => (
                <button
                  key={tk.name}
                  type="button"
                  onClick={() => insertToken(tk)}
                  title={
                    tk.description
                      ? `${tk.description}\n\n${t("ui.blockStylePanel.addToken", { name: tk.name })}`
                      : t("ui.blockStylePanel.addToken", { name: tk.name })
                  }
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    border: "1px solid var(--jf-border)",
                    borderRadius: 6,
                    background: "var(--jf-surface)",
                    padding: "0.3rem 0.45rem",
                    marginBottom: 3,
                    cursor: "pointer",
                    lineHeight: 1.35,
                  }}
                >
                  <code style={{ fontSize: "0.76rem", color: "var(--jf-text)" }}>{tk.name}</code>
                  <span
                    style={{
                      float: "right",
                      fontSize: "0.72rem",
                      color: "var(--jf-text-3)",
                      maxWidth: "45%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tk.value}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.72rem",
                      color: "var(--jf-text-2)",
                    }}
                  >
                    {tk.label}
                    {tk.presets ? ` — ${tk.presets.map((p) => p.label).join(" · ")}` : ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
