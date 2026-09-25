import { useT } from "../../i18n/I18nProvider";
import { useEffect, useRef, useState } from "react";
import type { BlockNode, BlockCatalogEntry } from "./types";
import { syncColumnCount } from "./block-defaults";
import AnimationPanel from "./AnimationPanel";
import ThemeBlockControls from "./ThemeBlockControls";
import BlockStylePanel from "./BlockStylePanel";
import BlockJsonPanel from "./BlockJsonPanel";
import GridPlacementPanel from "./GridPlacementPanel";
import BlockLayoutPanel from "./BlockLayoutPanel";
import ReusablePanel, { type ReusableItem } from "./ReusablePanel";
import { GRID_BLOCK_TYPE } from "./grid";
import MediaImageField from "../MediaImageField";
import { useMergeTags } from "../../lib/merge-tags";

const GALLERY_LAYOUTS = ["grid", "masonry", "carousel", "slideshow", "list"] as const;
type GalleryLayoutValue = (typeof GALLERY_LAYOUTS)[number];

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  fontSize: "0.8rem",
  fontWeight: 600,
  color: "var(--jf-text-2)",
  marginBottom: "0.75rem",
};

const fieldInput: React.CSSProperties = {
  padding: "0.4rem 0.6rem",
  border: "1px solid var(--jf-border-strong)",
  borderRadius: 5,
  fontSize: "0.875rem",
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const fieldHint: React.CSSProperties = {
  fontWeight: 400,
  color: "var(--jf-text-3)",
  fontSize: "0.7rem",
};

function linesOf(items: unknown, keys: string[]): string {
  if (typeof items === "string") return items;
  if (!Array.isArray(items)) return "";
  return items
    .map((row) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      return keys.map((key) => String(item[key] ?? "")).join(" | ");
    })
    .join("\n");
}

function parsePipes(text: string, keys: string[]): Record<string, string>[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const bits = line.split("|").map((bit) => bit.trim());
      const row: Record<string, string> = {};
      keys.forEach((key, index) => {
        row[key] = bits[index] ?? "";
      });
      if (keys.length > 0 && bits.length > keys.length) {
        row[keys[keys.length - 1]!] = bits.slice(keys.length - 1).join(" | ");
      }
      return row;
    });
}

function productListLines(items: unknown): string {
  if (typeof items === "string") return items;
  if (!Array.isArray(items)) return "";
  return items
    .map((row) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const colors = Array.isArray(item.colors)
        ? (item.colors as Array<{ name?: string; colorBg?: string }>)
            .map((color) => `${color.name ?? ""}:${color.colorBg ?? ""}`)
            .join(",")
        : String(item.colors ?? "");
      return [
        item.imageSrc,
        item.name,
        item.price,
        item.href,
        item.color,
        item.description,
        item.rating,
        item.reviewCount,
        colors,
      ]
        .map((value) => String(value ?? ""))
        .join(" | ");
    })
    .join("\n");
}

function sectionsToText(sections: unknown): string {
  if (typeof sections === "string") return sections;
  if (!Array.isArray(sections)) return "";
  return sections
    .map((row) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const name = String(item.name ?? "");
      const items = Array.isArray(item.items) ? item.items.map((line) => `- ${String(line)}`).join("\n") : "";
      return `${name}\n${items}`.trim();
    })
    .join("\n\n");
}

function textToSections(text: string, fallbackName: string): Array<{ name: string; items: string[] }> {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((chunk) => {
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      return {
        name: (lines[0] ?? fallbackName).replace(/:$/, ""),
        items: lines.slice(1).map((line) => line.replace(/^\s*[-*]\s*/, "")),
      };
    })
    .filter((section) => section.name || section.items.length > 0);
}

interface BlockInspectorProps {
  block: BlockNode;
  catalogEntry?: BlockCatalogEntry;
  onChange: (props: Record<string, unknown>) => void;
  onSyncBlock?: (block: BlockNode) => void;
  /** Type of the block this one sits in, so grid children can be placed. */
  parentType?: string | null;
  /** Column count of the grid parent, when there is one. */
  parentColumns?: number;
  reusable?: ReusableItem[];
  onReloadReusable?: () => void;
  onConvertToReusable?: (ref: string) => void;
}

export default function BlockInspector({
  block,
  catalogEntry,
  onChange,
  onSyncBlock,
  parentType = null,
  parentColumns = 12,
  reusable = [],
  onReloadReusable,
  onConvertToReusable,
}: BlockInspectorProps) {
  const { t } = useT();
  const mergeTags = useMergeTags();
  const p = block.props;
  const set = (key: string, val: unknown) => {
    const next = { ...p, [key]: val };
    onChange(next);
    if (block.type === "core.columns" && key === "columns") {
      onSyncBlock?.(syncColumnCount({ ...block, props: next }));
    }
  };

  const insertTag = (key: string, tag: string) => {
    const current = String(p[key] ?? "");
    const spacer = current && !current.endsWith(" ") ? " " : "";
    set(key, `${current}${spacer}${tag}`);
  };

  const tagKeys = mergeTags ? Object.keys(mergeTags) : [];
  const productTagBar = (key: string) =>
    tagKeys.length > 0 ? (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", margin: "-0.35rem 0 0.75rem" }}>
        {tagKeys.map((name) => (
          <button
            key={name}
            type="button"
            className="jf-btn jf-btn--ghost"
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
            onClick={() => insertTag(key, `{{${name}}}`)}
          >
            {`{{${name}}}`}
          </button>
        ))}
      </div>
    ) : null;

  const textArea = (key: string, label: string, rows = 3, withTags = false) => (
    <>
      <label style={fieldLabel}>
        {label}
        <textarea rows={rows} style={fieldInput} value={(p[key] as string) ?? ""} onChange={(e) => set(key, e.target.value)} />
      </label>
      {withTags ? productTagBar(key) : null}
    </>
  );

  const textInput = (key: string, label: string, placeholder = "", withTags = false) => (
    <>
      <label style={fieldLabel}>
        {label}
        <input type="text" style={fieldInput} placeholder={placeholder} value={(p[key] as string) ?? ""} onChange={(e) => set(key, e.target.value)} />
      </label>
      {withTags ? productTagBar(key) : null}
    </>
  );

  const select = (key: string, label: string, options: { value: string; label: string }[]) => (
    <label style={fieldLabel}>
      {label}
      <select style={fieldInput} value={String(p[key] ?? options[0]?.value)} onChange={(e) => set(key, e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );

  let fields: React.ReactNode;

  switch (block.type) {
    case "core.section":
      fields = <>
        {select("background", t("builder.inspector.field.background"), [
          { value: "default", label: t("common.default") },
          { value: "muted", label: t("builder.inspector.option.backgroundMuted") },
          { value: "primary", label: t("builder.inspector.option.backgroundPrimaryTint") },
          { value: "dark", label: t("builder.inspector.option.backgroundDark") },
          { value: "gradient", label: t("builder.inspector.option.backgroundGradient") },
        ])}
        {select("padding", t("builder.inspector.field.padding"), [
          { value: "sm", label: t("builder.layout.value.sm") },
          { value: "md", label: t("builder.layout.value.md") },
          { value: "lg", label: t("builder.layout.value.lg") },
          { value: "xl", label: t("builder.inspector.option.extraLarge") },
        ])}
        {select("align", t("builder.inspector.field.alignment"), [
          { value: "left", label: t("builder.layout.value.left") },
          { value: "center", label: t("builder.layout.value.center") },
        ])}
      </>;
      break;

    case "core.container":
      fields = select("width", t("builder.inspector.field.width"), [
        { value: "narrow", label: t("builder.layout.value.narrow") },
        { value: "default", label: t("common.default") },
        { value: "wide", label: t("builder.layout.value.wide") },
        { value: "full", label: t("builder.layout.value.full") },
      ]);
      break;

    case "core.columns":
      fields = <>
        <label style={fieldLabel}>{t("builder.inspector.field.columns")}
          <input type="number" style={fieldInput} min={2} max={4} value={(p.columns as number) ?? 2} onChange={(e) => set("columns", Number(e.target.value))} />
        </label>
        {select("gap", t("builder.inspector.field.gap"), [
          { value: "sm", label: t("builder.layout.value.sm") },
          { value: "md", label: t("builder.layout.value.md") },
          { value: "lg", label: t("builder.layout.value.lg") },
        ])}
      </>;
      break;

    case "core.hero":
      fields = <>
        {textInput("heading", t("builder.inspector.field.heading"))}
        {textArea("subheading", t("builder.inspector.field.subheading"), 2)}
        {textInput("buttonLabel", t("builder.inspector.field.buttonLabel"))}
        <InternalLinkField value={(p.buttonUrl as string) ?? ""} onChange={(url) => set("buttonUrl", url)} label={t("builder.inspector.field.buttonUrl")} placeholder={t("builder.inspector.placeholder.internalLink")} />
        {textInput("backgroundImage", t("builder.inspector.field.backgroundImageUrl"))}
        {select("align", t("builder.inspector.field.alignment"), [
          { value: "left", label: t("builder.layout.value.left") },
          { value: "center", label: t("builder.layout.value.center") },
        ])}
      </>;
      break;

    case "core.features":
      fields = <FeaturesEditor items={(p.items as FeatureItem[]) ?? []} heading={(p.heading as string) ?? ""} columns={(p.columns as number) ?? 3} onChange={onChange} p={p} />;
      break;

    case "core.cta":
      fields = <>
        {textInput("heading", t("builder.inspector.field.heading"))}
        {textArea("text", t("builder.inspector.field.text"), 2)}
        {textInput("buttonLabel", t("builder.inspector.field.buttonLabel"))}
        <InternalLinkField value={(p.buttonUrl as string) ?? ""} onChange={(url) => set("buttonUrl", url)} label={t("builder.inspector.field.buttonUrl")} />
        {select("variant", t("builder.inspector.field.style"), [
          { value: "primary", label: t("builder.inspector.option.primary") },
          { value: "dark", label: t("builder.inspector.option.backgroundDark") },
        ])}
      </>;
      break;

    case "core.paragraph": fields = textArea("text", t("builder.inspector.field.text"), 5, true); break;
    case "core.heading":
      fields = <>
        {textInput("text", t("builder.inspector.field.headingText"), "", true)}
        <label style={fieldLabel}>{t("builder.inspector.field.level")}
          <select style={fieldInput} value={(p.level as number) ?? 2} onChange={(e) => set("level", Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>H{n}</option>)}
          </select>
        </label>
      </>;
      break;
    case "core.image":
      fields = <>
        <MediaImageField
          id={`block-${block.id}-image`}
          label={t("builder.inspector.field.image")}
          value={(p.src as string) ?? ""}
          onChange={(url) => set("src", url)}
        />
        {textInput("alt", t("builder.inspector.field.altText"))}
        {textInput("caption", t("builder.inspector.field.caption"))}
        <div className="jf-block-panel__grid2">
          <label className="jf-block-panel__field jf-block-panel__field--inline">{t("builder.inspector.field.widthPx")}
            <input type="number" min={0} max={10000} placeholder={t("builder.inspector.placeholder.auto")} value={(p.width as number) || ""} onChange={(e) => set("width", Number(e.target.value) || 0)} />
          </label>
          <label className="jf-block-panel__field jf-block-panel__field--inline">{t("builder.inspector.field.heightPx")}
            <input type="number" min={0} max={10000} placeholder={t("builder.inspector.placeholder.auto")} value={(p.height as number) || ""} onChange={(e) => set("height", Number(e.target.value) || 0)} />
          </label>
        </div>
        {select("objectFit", t("builder.inspector.field.imageFit"), [
          { value: "contain", label: t("builder.inspector.option.contain") },
          { value: "cover", label: t("builder.inspector.option.cover") },
          { value: "fill", label: t("builder.inspector.option.stretch") },
        ])}
      </>;
      break;
    case "core.quote":
      fields = <>{textArea("text", t("builder.inspector.field.quote"), 3)}{textInput("attribution", t("builder.inspector.field.attribution"))}</>;
      break;
    case "core.button":
      fields = <>
        {textInput("label", t("builder.inspector.field.label"))}
        <InternalLinkField value={(p.url as string) ?? ""} onChange={(url) => set("url", url)} label={t("builder.inspector.field.url")} />
        {select("variant", t("builder.inspector.field.variant"), [
          { value: "primary", label: t("builder.inspector.option.primary") },
          { value: "secondary", label: t("builder.inspector.option.secondary") },
          { value: "outline", label: t("builder.inspector.option.outline") },
        ])}
      </>;
      break;
    case "core.link-list":
      fields = <LinkListEditor items={(p.items as LinkItem[]) ?? []} heading={(p.heading as string) ?? ""} onChange={onChange} p={p} />;
      break;
    case "core.spacer":
      fields = (
        <label style={fieldLabel}>{t("builder.inspector.field.heightPx")}
          <input type="number" style={fieldInput} min={8} max={500} value={(p.height as number) ?? 40} onChange={(e) => set("height", Number(e.target.value))} />
        </label>
      );
      break;
    case "core.code":
      fields = <>{textArea("code", t("builder.inspector.field.code"), 8)}{textInput("language", t("builder.inspector.field.language"))}</>;
      break;
    case "core.embed": fields = textInput("url", t("builder.inspector.field.url")); break;
    case "core.html": fields = textArea("html", t("builder.inspector.field.html"), 6, true); break;
    case "core.divider":
      fields = <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>{t("builder.inspector.noSettings")}</p>;
      break;
    case "core.color-scheme":
      fields = <>
        {select("style", t("builder.inspector.field.style"), [
          { value: "buttons", label: t("builder.inspector.option.buttons") },
          { value: "icons", label: t("builder.inspector.option.icons") },
          { value: "segmented", label: t("builder.inspector.option.segmentedControl") },
          { value: "toggle", label: t("builder.inspector.option.singleSunMoonToggle") },
          { value: "switch", label: t("builder.inspector.option.switch") },
          { value: "select", label: t("builder.inspector.option.compactDropdown") },
          { value: "labels", label: t("builder.inspector.option.textLabels") },
          { value: "tooltip-icons", label: t("builder.inspector.option.iconButtonsWithTooltips") },
        ])}
        {select("align", t("builder.inspector.field.alignment"), [
          { value: "left", label: t("builder.layout.value.left") },
          { value: "center", label: t("builder.layout.value.center") },
          { value: "right", label: t("builder.layout.value.right") },
        ])}
        {select("size", t("builder.inspector.field.size"), [
          { value: "sm", label: t("builder.layout.value.sm") },
          { value: "md", label: t("builder.layout.value.md") },
          { value: "lg", label: t("builder.layout.value.lg") },
        ])}
        {select("radius", t("builder.inspector.field.corners"), [
          { value: "pill", label: t("builder.layout.value.pill") },
          { value: "rounded", label: t("builder.inspector.option.rounded") },
          { value: "square", label: t("builder.inspector.option.square") },
        ])}
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showSystem === true} onChange={(e) => set("showSystem", e.target.checked)} />
          {t("builder.inspector.colorScheme.showAutoOption")}
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.animate !== false} onChange={(e) => set("animate", e.target.checked)} />
          {t("builder.inspector.colorScheme.animateIconChange")}
        </label>
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          {t("builder.inspector.colorScheme.autoHint")}
        </p>
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
          {t("builder.inspector.colorScheme.iconsHint")}
        </p>
        {textInput("lightIcon", t("builder.inspector.colorScheme.lightIcon"), "☀")}
        {textInput("lightLabel", t("builder.inspector.colorScheme.lightLabel"), t("builder.inspector.colorScheme.lightDefault"))}
        {textInput("darkIcon", t("builder.inspector.colorScheme.darkIcon"), "☾")}
        {textInput("darkLabel", t("builder.inspector.colorScheme.darkLabel"), t("builder.inspector.colorScheme.darkDefault"))}
        {p.showSystem === true ? textInput("autoIcon", t("builder.inspector.colorScheme.autoIcon"), "◐") : null}
        {p.showSystem === true ? textInput("autoLabel", t("builder.inspector.colorScheme.autoLabel"), t("builder.inspector.colorScheme.autoDefault")) : null}
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
          {t("builder.inspector.colorScheme.hoverHint", { cssVar: "--jf-color-scheme-*" })}
        </p>
      </>;
      break;
    case "core.language-switcher":
      fields = <>
        {select("style", t("builder.inspector.field.style"), [
          { value: "locale-full", label: t("builder.inspector.option.localeFull") },
          { value: "locale-short", label: t("builder.inspector.option.localeShort") },
          { value: "flags", label: t("builder.inspector.option.flags") },
          { value: "flag-locale", label: t("builder.inspector.option.flagAndLocale") },
          { value: "flag-country", label: t("builder.inspector.option.flagAndCountryName") },
        ])}
        {select("align", t("builder.inspector.field.alignment"), [
          { value: "left", label: t("builder.layout.value.left") },
          { value: "center", label: t("builder.layout.value.center") },
          { value: "right", label: t("builder.layout.value.right") },
        ])}
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>{t("builder.inspector.languageSwitcherHint")}</p>
      </>;
      break;
    case "core.auth-links":
      fields = <>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showLogin !== false} onChange={(e) => set("showLogin", e.target.checked)} />
          {t("builder.inspector.authLinks.showLogin")}
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showRegister !== false} onChange={(e) => set("showRegister", e.target.checked)} />
          {t("builder.inspector.authLinks.showRegister")}
        </label>
        {textInput("loginLabel", t("builder.inspector.authLinks.loginLabel"))}
        {textInput("registerLabel", t("builder.inspector.authLinks.registerLabel"))}
        {select("style", t("builder.inspector.field.style"), [
          { value: "buttons", label: t("builder.inspector.option.buttons") },
          { value: "links", label: t("builder.inspector.option.links") },
        ])}
        {select("align", t("builder.inspector.field.alignment"), [
          { value: "left", label: t("builder.layout.value.left") },
          { value: "center", label: t("builder.layout.value.center") },
          { value: "right", label: t("builder.layout.value.right") },
        ])}
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          {t("builder.inspector.authLinks.registerHint")}
        </p>
      </>;
      break;
    case "core.search":
      fields = <>
        {textInput("label", t("search.label"))}
        {textInput("contentType", t("search.scope"), t("search.allTypes"))}
        {textInput("taxonomy", t("search.taxonomySlug"))}
        {textInput("term", t("search.termSlug"))}
        {textInput("limit", t("search.limit"))}
        <label><input type="checkbox" checked={p.showFilters === true} onChange={e => onChange({ ...p, showFilters: e.target.checked })} /> {t("search.showFilters")}</label>
      </>;
      break;
    case "core.group":
    case "core.column":
      fields = <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>{t("builder.inspector.addContentBlocksHint")}</p>;
      break;
    case "justflows.gallery.grid":
      fields = (
        <GalleryEditor
          items={(Array.isArray(p.items) ? p.items : []) as GalleryItem[]}
          layout={GALLERY_LAYOUTS.includes(p.layout as GalleryLayoutValue) ? (p.layout as GalleryLayoutValue) : "grid"}
          columns={Number(p.columns) || 3}
          lightbox={p.lightbox !== false}
          onChange={onChange}
          p={p}
        />
      );
      break;
    case "justflows.blog.postList":
      fields = <>
        {select("layout", t("builder.inspector.field.layout"), [
          { value: "grid", label: t("builder.inspector.option.grid") },
          { value: "list", label: t("builder.inspector.option.list") },
        ])}
        <label style={fieldLabel}>{t("builder.inspector.postList.columnsGridLayout")}
          <input type="number" style={fieldInput} min={1} max={4} value={(p.columns as number) ?? 3} onChange={(e) => set("columns", Number(e.target.value))} />
        </label>
        <label style={fieldLabel}>{t("builder.inspector.postList.postsPerPage")}
          <input
            type="number"
            style={fieldInput}
            min={0}
            max={100}
            placeholder={t("builder.inspector.placeholder.useSiteDefault")}
            value={(p.postsPerPage as number) || ""}
            onChange={(e) => set("postsPerPage", e.target.value === "" ? 0 : Number(e.target.value))}
          />
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showFeaturedImage !== false} onChange={(e) => set("showFeaturedImage", e.target.checked)} />
          {t("builder.inspector.postList.showFeaturedImage")}
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showDate !== false} onChange={(e) => set("showDate", e.target.checked)} />
          {t("builder.inspector.postList.showDate")}
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showExcerpt !== false} onChange={(e) => set("showExcerpt", e.target.checked)} />
          {t("builder.inspector.postList.showExcerpt")}
        </label>
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          {t("builder.inspector.postList.hint")}
        </p>
      </>;
      break;
    default: {
      const schema = catalogEntry?.schema;
      const keys = schema ? Object.keys(schema) : [];
      fields = keys.length === 0 ? (
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>{t("builder.inspector.noSettingsForBlock")}</p>
      ) : (
        <>
          {keys.map((key) => {
            const field = schema?.[key];
            const kind = field?.type ?? "string";
            const label = key;
            if (kind === "boolean") {
              return (
                <label key={key} style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
                  <input type="checkbox" checked={p[key] === true} onChange={(e) => set(key, e.target.checked)} />
                  {label}
                </label>
              );
            }
            if (kind === "number") {
              return (
                <label key={key} style={fieldLabel}>{label}
                  <input type="number" style={fieldInput} value={Number(p[key]) || 0} onChange={(e) => set(key, Number(e.target.value))} />
                </label>
              );
            }
            if (Array.isArray(field?.options) && field.options.length > 0) {
              return (
                <label key={key} style={fieldLabel}>{label}
                  <select style={fieldInput} value={String(p[key] ?? field.options[0])} onChange={(e) => set(key, e.target.value)}>
                    {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              );
            }
            if (kind === "textarea") {
              const value = Array.isArray(p[key]) ? JSON.stringify(p[key], null, 2) : String(p[key] ?? "");
              return (
                <label key={key} style={fieldLabel}>{label}
                  <textarea rows={4} style={fieldInput} value={value} onChange={(e) => set(key, e.target.value)} />
                </label>
              );
            }
            return (
              <label key={key} style={fieldLabel}>{label}
                <input style={fieldInput} value={String(p[key] ?? "")} onChange={(e) => set(key, e.target.value)} />
              </label>
            );
          })}
        </>
      );
      break;
    }
  }

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: "0.75rem", color: "var(--jf-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.75rem" }}>
        {catalogEntry?.icon} {catalogEntry?.title ?? block.type}
      </div>
      {fields}
      <ThemeBlockControls block={block} onChange={onChange} />
      <AnimationPanel
        blockId={block.id}
        value={p.animation}
        onChange={(animation) => {
          if (!animation) {
            const next = { ...p };
            delete next.animation;
            onChange(next);
            return;
          }
          onChange({ ...p, animation });
        }}
      />
      {parentType === GRID_BLOCK_TYPE && (
        <GridPlacementPanel block={block} columns={parentColumns} onChange={onChange} />
      )}
      {onConvertToReusable && onReloadReusable && (
        <ReusablePanel
          block={block}
          items={reusable}
          onReload={onReloadReusable}
          onConvert={onConvertToReusable}
        />
      )}
      <BlockLayoutPanel block={block} onChange={onChange} />
      <BlockStylePanel block={block} onChange={onChange} />
      {onSyncBlock && <BlockJsonPanel key={block.id} block={block} onApply={onSyncBlock} />}
    </div>
  );
}

interface FeatureItem { icon: string; title: string; description: string }

function FeaturesEditor({ items, heading, columns, onChange, p }: {
  items: FeatureItem[];
  heading: string;
  columns: number;
  onChange: (props: Record<string, unknown>) => void;
  p: Record<string, unknown>;
}) {
  const [open, setOpen] = useState<number | null>(0);

  function updateItem(i: number, patch: Partial<FeatureItem>) {
    const next = items.map((item, idx) => (idx === i ? { ...item, ...patch } : item));
    onChange({ ...p, items: next });
  }

  function addItem() {
    onChange({ ...p, items: [...items, { icon: "✦", title: t("builder.inspector.features.newFeature"), description: "" }] });
    setOpen(items.length);
  }

  function removeItem(i: number) {
    onChange({ ...p, items: items.filter((_, idx) => idx !== i) });
  }

  const { t } = useT();

  return (
    <>
      <label style={fieldLabel}>{t("builder.inspector.features.sectionHeading")}
        <input type="text" style={fieldInput} value={heading} onChange={(e) => onChange({ ...p, heading: e.target.value })} />
      </label>
      <label style={fieldLabel}>{t("builder.inspector.field.columns")}
        <input type="number" style={fieldInput} min={2} max={4} value={columns} onChange={(e) => onChange({ ...p, columns: Number(e.target.value) })} />
      </label>
      <div style={{ marginTop: "0.5rem" }}>
        {items.map((item, i) => (
          <div key={i} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, marginBottom: "0.5rem", overflow: "hidden" }}>
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              style={{ width: "100%", padding: "0.5rem 0.75rem", background: "var(--jf-surface-2)", border: "none", textAlign: "left", fontWeight: 600, fontSize: "0.8rem", cursor: "pointer" }}
            >
              {item.icon} {item.title || t("builder.inspector.features.featureN", { n: i + 1 })}
            </button>
            {open === i && (
              <div style={{ padding: "0.75rem" }}>
                <label style={fieldLabel}>{t("builder.inspector.field.icon")}
                  <input type="text" style={fieldInput} value={item.icon} onChange={(e) => updateItem(i, { icon: e.target.value })} />
                </label>
                <label style={fieldLabel}>{t("builder.inspector.field.title")}
                  <input type="text" style={fieldInput} value={item.title} onChange={(e) => updateItem(i, { title: e.target.value })} />
                </label>
                <label style={fieldLabel}>{t("builder.inspector.field.description")}
                  <textarea rows={2} style={fieldInput} value={item.description} onChange={(e) => updateItem(i, { description: e.target.value })} />
                </label>
                <button type="button" onClick={() => removeItem(i)} style={{ color: "var(--jf-danger)", background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer" }}>{t("builder.inspector.remove")}</button>
              </div>
            )}
          </div>
        ))}
        <button type="button" onClick={addItem} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}>
          {t("builder.inspector.features.addFeature")}
        </button>
      </div>
    </>
  );
}

interface InternalLinkOption { id: string; type: string; title: string; slug: string }

let internalLinkCache: InternalLinkOption[] | null = null;

/**
 * Free-text URL input with a picker for the site's own published pages/posts,
 * so an internal link can be chosen by title instead of hand-typed and mistyped.
 * Stores a plain root-relative path (e.g. "/about"), same as a typed one.
 */
function InternalLinkField({ value, onChange, label, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const { t } = useT();
  const resolvedLabel = label ?? t("builder.inspector.field.url");
  const resolvedPlaceholder = placeholder ?? t("builder.inspector.placeholder.internalLink");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<InternalLinkOption[]>(internalLinkCache ?? []);

  async function togglePicker() {
    if (open) { setOpen(false); return; }
    if (internalLinkCache) { setOptions(internalLinkCache); setOpen(true); return; }
    setLoading(true);
    try {
      const [pagesRes, postsRes] = await Promise.all([
        fetch("/api/content?type=page&status=published&limit=100"),
        fetch("/api/content?type=post&status=published&limit=100"),
      ]);
      const [pagesBody, postsBody] = await Promise.all([
        pagesRes.json() as Promise<{ items?: InternalLinkOption[] }>,
        postsRes.json() as Promise<{ items?: InternalLinkOption[] }>,
      ]);
      const found = [...(pagesBody.items ?? []), ...(postsBody.items ?? [])];
      internalLinkCache = found;
      setOptions(found);
      setOpen(true);
    } catch {
      setOptions([]);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <label style={fieldLabel}>
      {resolvedLabel}
      <div style={{ display: "flex", gap: "0.35rem" }}>
        <input
          type="text"
          style={{ ...fieldInput, flex: 1 }}
          placeholder={resolvedPlaceholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={togglePicker}
          title={t("builder.inspector.internalLink.pickPageOrPost")}
          aria-label={t("builder.inspector.internalLink.pickPageOrPost")}
          style={{ padding: "0 0.6rem", border: "1px solid var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.9rem" }}
        >
          {loading ? "…" : "📄"}
        </button>
      </div>
      {open && (
        <div style={{ border: "1px solid var(--jf-border)", borderRadius: 6, maxHeight: 220, overflow: "auto", background: "#fff" }}>
          {options.length === 0 ? (
            <div style={{ padding: "0.5rem 0.6rem", fontSize: "0.75rem", color: "var(--jf-text-3)" }}>{t("builder.inspector.internalLink.noPublishedYet")}</div>
          ) : (
            options.map((item) => (
              <button
                key={`${item.type}-${item.id}`}
                type="button"
                onClick={() => { onChange(`/${item.slug}`); setOpen(false); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "0.4rem 0.6rem", border: "none", borderBottom: "1px solid var(--jf-border)", background: "none", cursor: "pointer", fontSize: "0.8rem" }}
              >
                <span style={{ color: "var(--jf-text-3)", marginRight: "0.35rem" }}>{item.type === "page" ? "📄" : "📝"}</span>
                {item.title || t("builder.inspector.internalLink.untitled", { type: item.type })}
                <span style={{ color: "var(--jf-text-3)" }}> — /{item.slug}</span>
              </button>
            ))
          )}
        </div>
      )}
    </label>
  );
}

interface LinkItem { label: string; url: string }

function LinkListEditor({ items, heading, onChange, p }: {
  items: LinkItem[];
  heading: string;
  onChange: (props: Record<string, unknown>) => void;
  p: Record<string, unknown>;
}) {
  const { t } = useT();
  function updateItem(i: number, patch: Partial<LinkItem>) {
    const next = items.map((item, idx) => (idx === i ? { ...item, ...patch } : item));
    onChange({ ...p, items: next });
  }

  function addItem() {
    onChange({ ...p, items: [...items, { label: t("builder.inspector.linkList.newLink"), url: "/" }] });
  }

  function removeItem(i: number) {
    onChange({ ...p, items: items.filter((_, idx) => idx !== i) });
  }

  function moveItem(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ ...p, items: next });
  }

  return (
    <>
      <label style={fieldLabel}>{t("builder.inspector.linkList.headingOptional")}
        <input type="text" style={fieldInput} placeholder={t("builder.inspector.linkList.headingPlaceholder")} value={heading} onChange={(e) => onChange({ ...p, heading: e.target.value })} />
      </label>
      <div style={{ marginTop: "0.5rem" }}>
        {items.map((item, i) => (
          <div key={i} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, marginBottom: "0.5rem", padding: "0.6rem" }}>
            <label style={fieldLabel}>{t("builder.inspector.field.label")}
              <input type="text" style={fieldInput} value={item.label} onChange={(e) => updateItem(i, { label: e.target.value })} />
            </label>
            <InternalLinkField value={item.url} onChange={(url) => updateItem(i, { url })} />
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" onClick={() => moveItem(i, -1)} disabled={i === 0} style={{ background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer", color: "var(--jf-text-2)" }}>↑ {t("builder.inspector.moveUp")}</button>
              <button type="button" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1} style={{ background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer", color: "var(--jf-text-2)" }}>↓ {t("builder.inspector.moveDown")}</button>
              <button type="button" onClick={() => removeItem(i)} style={{ background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer", color: "var(--jf-danger)", marginLeft: "auto" }}>{t("builder.inspector.remove")}</button>
            </div>
          </div>
        ))}
        <button type="button" onClick={addItem} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}>
          {t("builder.inspector.linkList.addLink")}
        </button>
      </div>
    </>
  );
}

interface GalleryItem { src: string; alt: string; caption: string }

function GalleryEditor({
  items,
  layout,
  columns,
  lightbox,
  onChange,
  p,
}: {
  items: GalleryItem[];
  layout: GalleryLayoutValue;
  columns: number;
  lightbox: boolean;
  onChange: (props: Record<string, unknown>) => void;
  p: Record<string, unknown>;
}) {
  const { t } = useT();
  const [library, setLibrary] = useState<Array<{ url: string; filename: string }>>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  function emit(patch: Record<string, unknown>) {
    onChange({ ...p, items, layout, columns, lightbox, ...patch });
  }

  function loadLibrary() {
    setShowLibrary(true);
    fetch("/api/media?limit=80")
      .then((r) => r.json())
      .then((body: { items?: Array<{ url?: string; filename?: string; mime_type?: string; mimeType?: string }> }) => {
        const images = (body.items ?? []).filter((item) => {
          const mime = String(item.mimeType ?? item.mime_type ?? "");
          return mime.startsWith("image/") && item.url;
        });
        setLibrary(images.map((item) => ({ url: String(item.url), filename: String(item.filename ?? item.url) })));
      })
      .catch(() => setLibrary([]));
  }

  function addUrl(url: string) {
    if (!url) return;
    emit({ items: [...items, { src: url, alt: "", caption: "" }] });
  }

  async function uploadFiles(files: FileList) {
    setUploading(true);
    setUploadError("");
    const uploaded: GalleryItem[] = [];
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/media", { method: "POST", body: form });
        const data = (await res.json()) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error ?? t("builder.inspector.gallery.uploadFailed"));
        uploaded.push({ src: data.url, alt: "", caption: "" });
        setLibrary((prev) => [{ url: data.url as string, filename: file.name }, ...prev]);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (uploaded.length) emit({ items: [...items, ...uploaded] });
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <label style={fieldLabel}>
        {t("builder.inspector.field.layout")}
        <select style={fieldInput} value={layout} onChange={(e) => emit({ layout: e.target.value })}>
          <option value="grid">{t("builder.inspector.option.grid")}</option>
          <option value="masonry">{t("builder.inspector.option.masonry")}</option>
          <option value="carousel">{t("builder.inspector.option.carousel")}</option>
          <option value="slideshow">{t("builder.inspector.option.slideshowFade")}</option>
          <option value="list">{t("builder.inspector.option.list")}</option>
        </select>
      </label>
      {(layout === "grid" || layout === "masonry") && (
        <label style={fieldLabel}>
          {t("builder.inspector.field.columns")}
          <input type="number" min={2} max={6} style={fieldInput} value={columns} onChange={(e) => emit({ columns: Number(e.target.value) })} />
        </label>
      )}
      {(layout === "carousel" || layout === "slideshow") && (
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: "0 0 0.75rem" }}>
          {t("builder.inspector.gallery.carouselHint")}
        </p>
      )}
      <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
        <input type="checkbox" checked={lightbox} onChange={(e) => emit({ lightbox: e.target.checked })} />
        {t("builder.inspector.field.lightbox")}
      </label>

      {items.map((item, index) => (
        <div key={`${item.src}-${index}`} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, padding: "0.6rem", marginBottom: "0.5rem" }}>
          {item.src ? (
            <img src={item.src} alt="" style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 4, marginBottom: "0.4rem" }} />
          ) : null}
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder={t("builder.inspector.placeholder.imageUrl")}
            value={item.src}
            onChange={(e) => emit({ items: items.map((row, i) => (i === index ? { ...row, src: e.target.value } : row)) })}
          />
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder={t("builder.inspector.field.altText")}
            value={item.alt}
            onChange={(e) => emit({ items: items.map((row, i) => (i === index ? { ...row, alt: e.target.value } : row)) })}
          />
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder={t("builder.inspector.field.caption")}
            value={item.caption}
            onChange={(e) => emit({ items: items.map((row, i) => (i === index ? { ...row, caption: e.target.value } : row)) })}
          />
          <button type="button" onClick={() => emit({ items: items.filter((_, i) => i !== index) })} style={{ color: "var(--jf-danger)", background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer" }}>
            {t("builder.inspector.remove")}
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: uploading ? "default" : "pointer", fontSize: "0.8rem", marginBottom: "0.4rem" }}
      >
        {uploading ? t("builder.inspector.gallery.uploading") : t("builder.inspector.gallery.uploadFromDevice")}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml"
        multiple
        hidden
        onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); }}
      />
      {uploadError ? (
        <p style={{ color: "var(--jf-danger)", fontSize: "0.75rem", margin: "0 0 0.4rem" }}>{uploadError}</p>
      ) : null}
      <button type="button" onClick={() => addUrl("")} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem", marginBottom: "0.4rem" }}>
        {t("builder.inspector.gallery.addImageUrl")}
      </button>
      <button type="button" onClick={loadLibrary} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}>
        {t("builder.inspector.gallery.addFromMediaLibrary")}
      </button>
      {showLibrary && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem", marginTop: "0.5rem", maxHeight: 180, overflow: "auto" }}>
          {library.length === 0 ? (
            <p style={{ color: "var(--jf-text-3)", fontSize: "0.75rem", gridColumn: "1 / -1" }}>{t("builder.inspector.gallery.noImagesYet")}</p>
          ) : library.map((file) => (
            <button
              key={file.url}
              type="button"
              onClick={() => addUrl(file.url)}
              style={{ padding: 0, border: "1px solid var(--jf-border)", borderRadius: 4, overflow: "hidden", cursor: "pointer", background: "#fff" }}
              title={file.filename}
            >
              <img src={file.url} alt="" style={{ display: "block", width: "100%", height: 56, objectFit: "cover" }} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
