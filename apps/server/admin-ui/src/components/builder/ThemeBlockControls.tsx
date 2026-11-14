import { compactBlockStyle, parseBlockStyle } from "@justflows/blocks";
import { useT } from "../../i18n/I18nProvider";
import { useThemeStyleTokens, type ThemeStyleToken } from "../../lib/theme-style-tokens";
import type { BlockNode } from "./types";

/**
 * Style any block against the active theme without writing CSS.
 *
 * The theme's `manifest.blockControls` names the handful of variables most
 * relevant to a block type (shown up top); an "All theme variables" section
 * exposes every remaining `--…` the theme declares. Each is a real widget
 * (dropdown / slider / colour) and writes to `style.vars`, which lands on the
 * block's root element — so `var(--jf-rainbow)` etc. in the theme resolve to
 * the block's choice.
 *
 * `showAll` comes from the block's inspector sections. When it is off, only
 * the curated controls show, plus any other variable the block already sets
 * so it can still be cleared.
 */
export default function ThemeBlockControls({
  block,
  onChange,
  showAll = true,
}: {
  block: BlockNode;
  onChange: (props: Record<string, unknown>) => void;
  showAll?: boolean;
}) {
  const { t } = useT();
  const { theme, tokens, blockControls } = useThemeStyleTokens();
  if (tokens.length === 0) return null;

  const style = parseBlockStyle(block.props.style);
  const vars = style.vars;

  function setVar(name: string, value: string) {
    const nextVars = { ...vars };
    if (value) nextVars[name] = value;
    else delete nextVars[name];
    const props = { ...block.props };
    const next = compactBlockStyle(parseBlockStyle({ ...style, vars: nextVars }));
    if (next) props.style = next;
    else delete props.style;
    onChange(props);
  }

  const inherit = t("builder.themeControls.inherit");
  const curatedNames = new Set(blockControls[block.type] ?? []);
  const byName = new Map(tokens.map((tk) => [tk.name, tk]));
  const curated = [...curatedNames].map((n) => byName.get(n)).filter(Boolean) as ThemeStyleToken[];
  // `--jf-block-*` is the Layout panel's Background / Text / Accent — don't
  // duplicate it here. `--jf-color-scheme-*` only makes sense on that block.
  const rest = tokens.filter(
    (tk) =>
      !curatedNames.has(tk.name) &&
      !tk.name.startsWith("--jf-block-") &&
      (!tk.name.startsWith("--jf-color-scheme-") || block.type === "core.color-scheme") &&
      (showAll || vars[tk.name] !== undefined),
  );
  if (curated.length === 0 && rest.length === 0) return null;

  const field = (c: ThemeStyleToken) => {
    const current = String(vars[c.name] ?? "");
    const id = `${block.id}-${c.name.replace(/[^\w-]/g, "")}`;
    // What the active theme resolves this variable to right now. Always shown
    // so an editor sees the live value even when this block adds no override.
    const themeValue = c.value ?? "";
    const presetLabel = c.presets?.find((p) => p.value === themeValue)?.label;
    /** Says whether the inherited value is the theme's own or a change made for this site. */
    const sourceLabel = c.overridden ? t("builder.sources.siteToken") : t("builder.sources.themeDefault");
    const themeHint =
      !current && themeValue ? (
        <span style={themeHintStyle}>
          {sourceLabel}: <span className="jf-input--mono">{presetLabel ?? themeValue}</span>
        </span>
      ) : current ? (
        <span style={themeHintStyle}>{t("builder.sources.local")}</span>
      ) : null;

    if (c.presets && c.presets.length > 0) {
      return (
        <div className="jf-field" key={c.name} style={fieldWrap}>
          <label className="jf-field__label" htmlFor={id}>
            {c.label}
          </label>
          <select
            id={id}
            className="jf-input"
            value={current}
            onChange={(e) => setVar(c.name, e.target.value)}
          >
            <option value="">{presetLabel ? `${inherit} (${presetLabel})` : inherit}</option>
            {c.presets.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {themeHint}
        </div>
      );
    }

    if (c.type === "range") {
      const num = Number.parseFloat(current) || Number.parseFloat(themeValue) || c.min || 0;
      return (
        <div className="jf-field" key={c.name} style={fieldWrap}>
          <label className="jf-field__label" htmlFor={id}>
            {c.label}: {current || `${inherit} (${themeValue})`}
          </label>
          <div className="jf-row" style={{ flexWrap: "nowrap" }}>
            <input
              id={id}
              type="range"
              min={c.min ?? 0}
              max={c.max ?? 100}
              step={c.step ?? 1}
              value={num}
              onChange={(e) => setVar(c.name, `${e.target.value}${c.unit ?? ""}`)}
            />
            {current ? (
              <button
                type="button"
                onClick={() => setVar(c.name, "")}
                style={clearBtn}
                aria-label={`${inherit} — ${c.label}`}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
      );
    }

    if (c.type === "color") {
      const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
      const swatch = isHex(current) ? current : isHex(themeValue) ? themeValue : "#ffffff";
      return (
        <div className="jf-field" key={c.name} style={fieldWrap}>
          <label className="jf-field__label" htmlFor={id}>
            {c.label}
          </label>
          <div className="jf-row" style={{ flexWrap: "nowrap" }}>
            <input
              id={id}
              type="color"
              className="jf-swatch"
              value={swatch}
              onChange={(e) => setVar(c.name, e.target.value)}
            />
            <input
              type="text"
              className="jf-input jf-input--mono"
              placeholder={themeValue || inherit}
              value={current}
              spellCheck={false}
              onChange={(e) => setVar(c.name, e.target.value)}
            />
            {current ? (
              <button
                type="button"
                onClick={() => setVar(c.name, "")}
                style={clearBtn}
                aria-label={`${inherit} — ${c.label}`}
              >
                ×
              </button>
            ) : null}
          </div>
          {themeHint}
        </div>
      );
    }

    return (
      <div className="jf-field" key={c.name} style={fieldWrap}>
        <label className="jf-field__label" htmlFor={id}>
          {c.label}
        </label>
        <input
          id={id}
          type="text"
          className="jf-input jf-input--mono"
          placeholder={themeValue || inherit}
          value={current}
          spellCheck={false}
          onChange={(e) => setVar(c.name, e.target.value)}
        />
        {themeHint}
      </div>
    );
  };

  return (
    <section className="jf-block-panel" aria-labelledby={`jf-themectl-${block.id}`}>
      <h3 id={`jf-themectl-${block.id}`}>
        {t("builder.themeControls.title")}
        {theme ? <span style={themeNameStyle}> · {theme}</span> : null}
      </h3>
      <p className="jf-block-panel__hint">{t("builder.themeControls.hint")}</p>

      {curated.map(field)}

      <details className="jf-block-panel__compiled" open={curated.length === 0}>
        <summary>
          {t("builder.themeControls.all")} ({rest.length})
        </summary>
        <div style={{ marginTop: "0.5rem" }}>{rest.map(field)}</div>
      </details>
    </section>
  );
}

const clearBtn: React.CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--jf-border-strong)",
  borderRadius: "var(--jf-radius-sm)",
  background: "var(--jf-surface)",
  color: "var(--jf-text-3)",
  cursor: "pointer",
  padding: "0 0.4rem",
  height: 30,
};

const fieldWrap: React.CSSProperties = { marginBottom: "0.6rem" };

const themeHintStyle: React.CSSProperties = {
  display: "block",
  marginTop: "0.25rem",
  fontSize: "0.75rem",
  color: "var(--jf-text-3)",
};

const themeNameStyle: React.CSSProperties = { fontWeight: 400, color: "var(--jf-text-3)" };
