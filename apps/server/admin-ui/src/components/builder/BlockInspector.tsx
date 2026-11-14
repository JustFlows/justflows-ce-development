import SocialLinksEditor from "./SocialLinksEditor";
import { FUNCTIONAL_TYPES } from "./FunctionalBlock";
import TableEditor from "./TableEditor";
import { useT } from "../../i18n/I18nProvider";
import { useEffect, useId, useRef, useState } from "react";
import type { BlockNode, BlockCatalogEntry, BlockSchemaField } from "./types";
import { syncColumnCount } from "./block-defaults";
import AnimationPanel from "./AnimationPanel";
import ThemeBlockControls from "./ThemeBlockControls";
import BlockStylePanel from "./BlockStylePanel";
import { ContainerLayoutPanel, FlexItemPanel } from "./LayoutControls";
import { supportsContainerLayout, type BreakpointSource, type OverrideBreakpoint } from "@justflows/blocks";
import ResponsivePanel from "./ResponsivePanel";
import StylePresetPanel from "./StylePresetPanel";
import { useTemplateContext } from "./template-defaults-context";
import { useStylePresets } from "../../lib/style-presets";
import { presetRefOf } from "@justflows/blocks";
import BlockJsonPanel from "./BlockJsonPanel";
import GridPlacementPanel from "./GridPlacementPanel";
import BlockLayoutPanel from "./BlockLayoutPanel";
import ReusablePanel, { type ReusableItem } from "./ReusablePanel";
import { GRID_BLOCK_TYPE, gridColumns, matchReadingOrder, readingOrderDiffers } from "./grid";
import MediaImageField from "../MediaImageField";
import BlockRecoveryPanel, { type BlockRecoveryReason } from "./BlockRecoveryPanel";
import { useMergeTags } from "../../lib/merge-tags";
import { useThemeStyleTokens } from "../../lib/theme-style-tokens";
import { inspectorSections, type InspectorSections } from "./inspector-sections";
import { INSPECTOR_FIELDS } from "@justflows/blocks";
import { INSPECTOR_TABS, type InspectorTab } from "./shell/builder-prefs";


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
  /** The list parent determines whether the item has a visible checkbox. */
  parentListStyle?: string;
  /** Column count of the grid parent, when there is one. */
  parentColumns?: number;
  /** The parent's `containerLayout`, so a block in a row gets its item controls. */
  parentLayout?: unknown;
  /** Elements the ancestors render as, outermost first; see `ContainerLayoutPanel`. */
  ancestorElements?: readonly string[];
  /** The breakpoint the canvas is previewing, for the Responsive tab. */
  previewing?: BreakpointSource;
  /** Switch the canvas preview to a breakpoint. */
  onPreviewBreakpoint?: (bp: OverrideBreakpoint) => void;
  reusable?: ReusableItem[];
  onReloadReusable?: () => void;
  onConvertToReusable?: (ref: string) => void;
  /** Replace a linked reference with a local copy (justflows-ce#304). */
  onDetachReusable?: (blocks: BlockNode[]) => void;
  /** Open a reusable block's source in its editor. */
  onEditReusable?: (id: string) => void;
  /**
   * The loaded block catalog, for recovering blocks whose extension is off or
   * that are deprecated (justflows-ce#306). Without it no recovery panel shows.
   */
  catalog?: BlockCatalogEntry[];
  /** Swap the selected block for another, after the author confirmed. */
  onReplaceBlock?: (next: BlockNode) => void;
  /** Remove the selected block, after the author confirmed. */
  onRemoveBlock?: () => void;
  /** Load the block catalog again, e.g. after an extension was switched back on. */
  onReloadCatalog?: () => void;
  /** Only the block's own fields: no title, style, layout, animation, or JSON panels (widget rows). */
  compact?: boolean;
  /** Inspector tab to show, remembered per user by the builder shell. Defaults to Content. */
  tab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
}

/** A copy of the section switches limited to the given layout groups, for one inspector tab. */
function onlySections(
  sections: InspectorSections,
  groups: ReadonlyArray<keyof typeof INSPECTOR_FIELDS>,
): InspectorSections {
  const allowed = new Set<string>(groups.flatMap((group) => INSPECTOR_FIELDS[group]));
  return {
    ...sections,
    spacing: groups.includes("spacing") && sections.spacing,
    size: groups.includes("size") && sections.size,
    appearance: groups.includes("appearance") && sections.appearance,
    colors: groups.includes("colors") && sections.colors,
    field: (name) => allowed.has(name) && sections.field(name),
  };
}

export default function BlockInspector({
  block,
  catalogEntry,
  onChange,
  onSyncBlock,
  parentType = null,
  parentListStyle,
  parentColumns = 12,
  parentLayout,
  ancestorElements,
  previewing = "desktop",
  onPreviewBreakpoint,
  reusable = [],
  onReloadReusable,
  onConvertToReusable,
  onDetachReusable,
  onEditReusable,
  catalog,
  onReplaceBlock,
  onRemoveBlock,
  onReloadCatalog,
  compact = false,
  tab: requestedTab = "content",
  onTabChange,
}: BlockInspectorProps) {
  const { t } = useT();
  const [localTab, setLocalTab] = useState<InspectorTab>(requestedTab);
  const activeRequest = onTabChange ? requestedTab : localTab;
  const selectTab = (next: InspectorTab) => (onTabChange ? onTabChange(next) : setLocalTab(next));
  const mergeTags = useMergeTags();
  const { blockControls } = useThemeStyleTokens();
  const { presets } = useStylePresets();
  const p = block.props;
  const schemeStyle = typeof p.style === "string" ? p.style : "buttons";
  const schemeSingle = schemeStyle === "toggle" || schemeStyle === "switch";
  const schemeIcons = schemeStyle !== "select" && schemeStyle !== "switch";

  const sections = inspectorSections(block, catalogEntry, new Set(blockControls[block.type] ?? []));
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
        <MediaImageField id={`block-${block.id}-backgroundImage`} label={t("builder.inspector.field.backgroundImage")} value={(p.backgroundImage as string) ?? ""} onChange={(url) => set("backgroundImage", url)} />
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
    case "core.video":
    case "core.audio":
    case "core.file":
      fields = <>
        {Object.entries(catalogEntry?.schema ?? {}).map(([name, field]) => name === "poster" ? (
          <MediaImageField key={name} id={`block-${block.id}-poster`} label={t("builder.media.poster")} value={(p.poster as string) ?? ""} onChange={(url) => set("poster", url)} />
        ) : name === "src" ? (
          /** The source is picked from, or uploaded to, the media library like an image; a URL can still be pasted. */
          <MediaImageField key={name} id={`block-${block.id}-src`} label={t("builder.media.source")} kind={block.type === "core.video" ? "video" : block.type === "core.audio" ? "audio" : "file"} value={(p.src as string) ?? ""} onChange={(url) => set("src", url)} />
        ) : (
          <SchemaField key={name} name={name} field={{ ...field, label: t(`builder.media.${name}`) }} value={p[name]} onChange={(value) => set(name, value)} />
        ))}
        {block.type !== "core.file" && <p style={fieldHint}>{t("builder.media.autoplayHelp")}</p>}
        {block.type === "core.file" && <p style={fieldHint}>{t("builder.media.downloadHelp")}</p>}
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
        {!schemeSingle && <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showSystem === true} onChange={(e) => set("showSystem", e.target.checked)} />
          {t("builder.inspector.colorScheme.showAutoOption")}
        </label>}
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.animate !== false} onChange={(e) => set("animate", e.target.checked)} />
          {t("builder.inspector.colorScheme.animateIconChange")}
        </label>
        {!schemeSingle && <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          {t("builder.inspector.colorScheme.autoHint")}
        </p>}
        {schemeIcons && <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
          {t("builder.inspector.colorScheme.iconsHint")}
        </p>}
        {schemeIcons && textInput("lightIcon", t("builder.inspector.colorScheme.lightIcon"), "☀")}
        {!schemeSingle && textInput("lightLabel", t("builder.inspector.colorScheme.lightLabel"), t("builder.inspector.colorScheme.lightDefault"))}
        {schemeIcons && textInput("darkIcon", t("builder.inspector.colorScheme.darkIcon"), "☾")}
        {textInput("darkLabel", t("builder.inspector.colorScheme.darkLabel"), t("builder.inspector.colorScheme.darkDefault"))}
        {!schemeSingle && schemeIcons && p.showSystem === true ? textInput("autoIcon", t("builder.inspector.colorScheme.autoIcon"), "◐") : null}
        {!schemeSingle && p.showSystem === true ? textInput("autoLabel", t("builder.inspector.colorScheme.autoLabel"), t("builder.inspector.colorScheme.autoDefault")) : null}
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
        {p.showLogin !== false && textInput("loginLabel", t("builder.inspector.authLinks.loginLabel"))}
        {p.showRegister !== false && textInput("registerLabel", t("builder.inspector.authLinks.registerLabel"))}
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
        {p.showFeaturedImage !== false && (
          <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" checked={p.showPlaceholder !== false} onChange={(e) => set("showPlaceholder", e.target.checked)} />
            {t("builder.inspector.postList.showPlaceholder")}
          </label>
        )}
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
      if (FUNCTIONAL_TYPES.has(block.type)) {
        fields = <>
          {Object.entries(catalogEntry?.schema ?? {}).filter(([name, field]) => schemaFieldVisible(field, p, catalogEntry?.schema ?? {}) && !(block.type === "core.list-item" && name === "checked" && parentType === "core.list" && parentListStyle !== "checklist")).map(([name, field]) => name === "rows" ? (
            <TableEditor key={name} value={p.rows ?? field.default} onChange={(rows) => set("rows", rows)} />
          ) : name === "links" ? (
            <SocialLinksEditor key={name} value={p.links ?? field.default} onChange={(links) => set("links", links)} />
          ) : name === "poster" ? (
            <MediaImageField key={name} id={`block-${block.id}-poster`} label={t("builder.media.poster")} value={(p.poster as string) ?? ""} onChange={(url) => set("poster", url)} />
          ) : name === "src" && "mediaType" in (catalogEntry?.schema ?? {}) ? (
            /** Cover and Media & Text: an image or a video, depending on the chosen media type. */
            <MediaImageField
              key={`${name}-${p.mediaType === "video" ? "video" : "image"}`}
              id={`block-${block.id}-src`}
              label={p.mediaType === "video" ? t("builder.media.source") : t("builder.inspector.field.image")}
              kind={p.mediaType === "video" ? "video" : "image"}
              value={(p.src as string) ?? ""}
              onChange={(url) => set("src", url)}
            />
          ) : (
            <SchemaField key={name} name={name} field={{ ...field, label: t(`builder.functional.fields.${name}`), optionLabels: field.options ? Object.fromEntries(field.options.map(option => [option, t(`builder.functional.options.${option}`)])) : field.optionLabels }} value={p[name]} onChange={(value) => set(name, value)} />
          ))}
        </>;
        break;
      }
      const schema = catalogEntry?.schema ?? {};
      const keys = Object.keys(schema).filter((key) => schemaFieldVisible(schema[key]!, p, schema));
      fields = keys.length === 0 ? (
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>{t("builder.inspector.noSettingsForBlock")}</p>
      ) : (
        <>
          {keys.map((key) => (
            <SchemaField key={key} name={key} field={schema[key]!} value={p[key]} onChange={(value) => set(key, value)} />
          ))}
        </>
      );
      break;
    }
  }

  /**
   * A block whose extension is off has no settings to show, only its stored
   * data and the ways to recover it. A deprecated block keeps its settings
   * under the notice (justflows-ce#306).
   */
  const recovery: BlockRecoveryReason | null = !catalog?.length
    ? null
    : !catalogEntry && !block.type.startsWith("core.")
      ? "unavailable"
      : catalogEntry?.deprecated
        ? "deprecated"
        : null;
  if (recovery) {
    fields = (
      <>
        <BlockRecoveryPanel
          block={block}
          reason={recovery}
          entry={catalogEntry}
          catalog={catalog ?? []}
          onReplace={onReplaceBlock}
          onRemove={onRemoveBlock}
          onRetry={onReloadCatalog}
        />
        {recovery === "deprecated" ? fields : null}
      </>
    );
  }

  if (compact) return <div>{fields}</div>;

  const styleSections = onlySections(sections, ["appearance", "colors"]);
  const isContainer = supportsContainerLayout(block.type);
  const preset = presets.find((p) => p.id === presetRefOf(block.props)) ?? null;
  const templateContext = useTemplateContext();
  const templateLayer = templateContext?.defaults[block.type]
    ? { name: templateContext.slug, style: templateContext.defaults[block.type]! }
    : null;
  const layoutSections = onlySections(sections, ["spacing", "size"]);
  const showThemeControls = !catalogEntry?.schema?.style || Boolean(p.style && typeof p.style === "object");
  const panels: Record<InspectorTab, React.ReactNode> = {
    content: (
      <>
        {fields}
        {onConvertToReusable && onReloadReusable && (
          <ReusablePanel
            block={block}
            items={reusable}
            onReload={onReloadReusable}
            onConvert={onConvertToReusable}
            onDetach={onDetachReusable}
            onEdit={onEditReusable}
          />
        )}
      </>
    ),
    style:
      showThemeControls || styleSections.appearance || styleSections.colors ? (
        <>
          <StylePresetPanel block={block} onChange={onChange} />
          {showThemeControls && <ThemeBlockControls block={block} onChange={onChange} showAll={sections.themeVariables} />}
          <BlockLayoutPanel block={block} onChange={onChange} sections={styleSections} preset={preset} previewing={previewing} templateLayer={templateLayer} />
        </>
      ) : null,
    layout:
      isContainer || block.type === GRID_BLOCK_TYPE || parentType === GRID_BLOCK_TYPE || layoutSections.spacing || layoutSections.size ? (
        <>
          {isContainer && <ContainerLayoutPanel block={block} onChange={onChange} ancestorElements={ancestorElements} />}
          {block.type === GRID_BLOCK_TYPE && readingOrderDiffers(block.children ?? [], gridColumns(block)) && (
            <div className="jf-inspector-lock__notice" role="note">
              <p>{t("builder.container.readingOrder")}</p>
              {onSyncBlock && (
                <button
                  type="button"
                  className="jf-btn jf-btn--ghost jf-btn--sm"
                  onClick={() => onSyncBlock({ ...block, children: matchReadingOrder(block.children ?? [], gridColumns(block)) })}
                >
                  {t("builder.container.matchReadingOrder")}
                </button>
              )}
            </div>
          )}
          {parentType === GRID_BLOCK_TYPE && <GridPlacementPanel block={block} columns={parentColumns} onChange={onChange} />}
          {layoutSections.size && <FlexItemPanel block={block} onChange={onChange} parentLayout={parentLayout} />}
          <BlockLayoutPanel block={block} onChange={onChange} sections={layoutSections} preset={preset} previewing={previewing} templateLayer={templateLayer} />
        </>
      ) : null,
    responsive: (
      <>
        <ResponsivePanel
          block={block}
          onChange={onChange}
          previewing={previewing}
          onPreview={onPreviewBreakpoint}
          parentType={parentType}
          parentLayout={parentLayout}
        />
        {sections.advanced && <BlockStylePanel block={block} onChange={onChange} part="devices" />}
      </>
    ),
    interactions: sections.animation ? (
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
    ) : null,
    advanced:
      sections.advanced || onSyncBlock ? (
        <>
          {sections.advanced && <BlockStylePanel block={block} onChange={onChange} part="code" />}
          {onSyncBlock && <BlockJsonPanel key={block.id} block={block} onApply={onSyncBlock} />}
        </>
      ) : null,
  };
  const tabs = INSPECTOR_TABS.filter((name) => panels[name] !== null);
  const activeTab: InspectorTab = tabs.includes(activeRequest) ? activeRequest : "content";
  const tabId = (name: InspectorTab) => `jf-inspector-${block.id}-tab-${name}`;
  const panelId = `jf-inspector-${block.id}-panel`;

  /** Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects. */
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(activeTab);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    let next: InspectorTab | undefined;
    if (e.key === forward) next = tabs[(index + 1) % tabs.length];
    else if (e.key === backward) next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className="jf-inspector">
      <div className="jf-inspector__title">
        {catalogEntry?.icon} {block.editor?.label || catalogEntry?.title || block.type}
      </div>
      <div className="jf-inspector__tabs" role="tablist" aria-label={t("builder.shell.inspector")}>
        {tabs.map((name) => (
          <button
            key={name}
            id={tabId(name)}
            type="button"
            role="tab"
            className="jf-inspector__tab"
            aria-selected={activeTab === name}
            aria-controls={panelId}
            tabIndex={activeTab === name ? 0 : -1}
            onClick={() => selectTab(name)}
            onKeyDown={onTabKey}
          >
            {t(`builder.shell.tab.${name}`)}
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(activeTab)} className="jf-inspector__panel">
        {panels[activeTab]}
      </div>
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
        <button type="button" onClick={addItem} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "var(--jf-surface)", cursor: "pointer", fontSize: "0.8rem" }}>
          {t("builder.inspector.features.addFeature")}
        </button>
      </div>
    </>
  );
}

interface SchemaOption { value: string; label: string }

/** The value a schema field currently has, falling back to its default the way the block does. */
function schemaFieldValue(field: BlockSchemaField | undefined, value: unknown): unknown {
  if (value !== undefined && value !== null && value !== "") return value;
  if (field?.default !== undefined) return field.default;
  return field?.options?.[0];
}

/** `showWhen` lets a plugin hide fields that do not apply to the current choice. */
export function schemaFieldVisible(
  field: BlockSchemaField,
  props: Record<string, unknown>,
  schema: Record<string, BlockSchemaField>,
): boolean {
  const rule = field.showWhen;
  if (!rule?.field) return true;
  const current = String(schemaFieldValue(schema[rule.field], props[rule.field]) ?? "");
  const wanted = Array.isArray(rule.equals) ? rule.equals : [rule.equals];
  return wanted.map(String).includes(current);
}

function schemaList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return [];
}

/** Only same-origin paths; a plugin cannot point the editor at another host. */
function safeOptionsUrl(url: string | undefined): string | null {
  if (!url || !url.startsWith("/") || url.startsWith("//") || url.startsWith("/\\")) return null;
  return url;
}

const schemaOptionCache = new Map<string, SchemaOption[]>();

function useSchemaOptions(field: BlockSchemaField): { options: SchemaOption[]; loading: boolean; failed: boolean } {
  const url = safeOptionsUrl(field.optionsUrl);
  const staticOptions = (field.options ?? []).map((value) => ({ value, label: field.optionLabels?.[value] ?? value }));
  const [remote, setRemote] = useState<SchemaOption[] | null>(url ? schemaOptionCache.get(url) ?? null : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url || schemaOptionCache.has(url)) return;
    let cancelled = false;
    setFailed(false);
    fetch(url, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { options?: Array<{ value?: unknown; label?: unknown }> };
        const rows = (body.options ?? [])
          .map((row) => ({ value: String(row.value ?? ""), label: String(row.label ?? row.value ?? "") }))
          .filter((row) => row.value);
        schemaOptionCache.set(url, rows);
        if (!cancelled) setRemote(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!url) return { options: staticOptions, loading: false, failed: false };
  return { options: remote ?? [], loading: remote === null && !failed, failed };
}

/** Several choices as a searchable checkbox list. Checked values keep the order they were picked in. */
function MultiChoice({ options, value, onChange }: {
  options: SchemaOption[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((item) => item !== id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      {options.length > 8 && (
        <input
          type="search"
          style={fieldInput}
          placeholder={t("builder.inspector.schemaField.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div style={{ border: "1px solid var(--jf-border)", borderRadius: 6, maxHeight: 220, overflow: "auto", background: "var(--jf-surface)", padding: "0.25rem 0" }}>
        {shown.map((option) => (
          <label
            key={option.value}
            style={{ display: "flex", alignItems: "center", gap: "0.45rem", padding: "0.25rem 0.6rem", fontSize: "0.8rem", fontWeight: 400, cursor: "pointer" }}
          >
            <input type="checkbox" checked={value.includes(option.value)} onChange={(e) => toggle(option.value, e.target.checked)} />
            {option.label}
          </label>
        ))}
      </div>
      <span style={fieldHint}>{t("builder.inspector.schemaField.selected", { count: value.length })}</span>
    </div>
  );
}

/** One plugin block prop, rendered from its schema entry. */
function SchemaField({ name, field, value, onChange }: {
  name: string;
  field: BlockSchemaField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useT();
  const kind = field.type ?? "string";
  const label = field.label || name;
  const help = field.help ? <span style={fieldHint}>{field.help}</span> : null;
  const hasChoices = Boolean(field.optionsUrl) || (Array.isArray(field.options) && field.options.length > 0);
  const { options, loading, failed } = useSchemaOptions(field);
  const id = useId();

  /** One image: picked from or uploaded to the media library, with a URL as fallback. */
  if (kind === "media") {
    return <MediaImageField id={id} label={label} description={field.help} value={typeof value === "string" ? value : ""} onChange={onChange} />;
  }

  if (kind === "images") {
    return <ImagesField label={label} help={field.help} value={value} onChange={onChange} />;
  }

  if (kind === "boolean") {
    return (
      <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
        <input type="checkbox" checked={schemaFieldValue(field, value) === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  if (kind === "number") {
    return (
      <label style={fieldLabel}>{label}
        <input type="number" style={fieldInput} value={Number(schemaFieldValue(field, value)) || 0} onChange={(e) => onChange(Number(e.target.value))} />
        {help}
      </label>
    );
  }
  if (hasChoices) {
    const status = loading
      ? t("builder.inspector.schemaField.loading")
      : failed
        ? t("builder.inspector.schemaField.loadFailed")
        : options.length === 0
          ? t("builder.inspector.schemaField.noOptions")
          : "";
    if (field.multiple) {
      return (
        <div style={fieldLabel}>{label}
          {status ? <span style={fieldHint}>{status}</span> : <MultiChoice options={options} value={schemaList(value)} onChange={onChange} />}
          {help}
        </div>
      );
    }
    const current = String(schemaFieldValue(field, value) ?? "");
    return (
      <label style={fieldLabel}>{label}
        {status && field.optionsUrl ? <span style={fieldHint}>{status}</span> : (
          <select style={fieldInput} value={current} onChange={(e) => onChange(e.target.value)}>
            {field.optionsUrl && <option value="">{t("builder.inspector.schemaField.none")}</option>}
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
        {help}
      </label>
    );
  }
  if (kind === "textarea" || kind === "richtext") {
    const text = Array.isArray(value) ? JSON.stringify(value, null, 2) : String(value ?? "");
    return (
      <label style={fieldLabel}>{label}
        <textarea rows={4} style={fieldInput} value={text} onChange={(e) => onChange(e.target.value)} />
        {help}
      </label>
    );
  }
  return (
    <label style={fieldLabel}>{label}
      <input style={fieldInput} value={String(value ?? "")} placeholder={typeof field.default === "string" ? field.default : undefined} onChange={(e) => onChange(e.target.value)} />
      {help}
    </label>
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
          style={{ padding: "0 0.6rem", border: "1px solid var(--jf-border-strong)", borderRadius: 5, background: "var(--jf-surface)", cursor: "pointer", fontSize: "0.9rem" }}
        >
          {loading ? "…" : "📄"}
        </button>
      </div>
      {open && (
        <div style={{ border: "1px solid var(--jf-border)", borderRadius: 6, maxHeight: 220, overflow: "auto", background: "var(--jf-surface)" }}>
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
        <button type="button" onClick={addItem} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "var(--jf-surface)", cursor: "pointer", fontSize: "0.8rem" }}>
          {t("builder.inspector.linkList.addLink")}
        </button>
      </div>
    </>
  );
}

interface ImageItem { src: string; alt: string; caption: string }

/** Read a stored `images` value, dropping rows that are not objects. */
function imageItems(value: unknown): ImageItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({ src: String(row.src ?? ""), alt: String(row.alt ?? ""), caption: String(row.caption ?? "") }));
}

/**
 * The `images` block field: a list of images, each added by upload, from the
 * media library, or by URL, with alt text and a caption. Saved as
 * `{ src, alt, caption }[]`.
 */
function ImagesField({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help?: string;
  value: unknown;
  onChange: (items: ImageItem[]) => void;
}) {
  const { t } = useT();
  const items = imageItems(value);
  const [library, setLibrary] = useState<Array<{ url: string; filename: string }>>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  function emit(next: ImageItem[]) {
    onChange(next);
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
    emit([...items, { src: url, alt: "", caption: "" }]);
  }

  async function uploadFiles(files: FileList) {
    setUploading(true);
    setUploadError("");
    const uploaded: ImageItem[] = [];
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/media", { method: "POST", body: form });
        const data = (await res.json()) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error ?? t("builder.inspector.images.uploadFailed"));
        uploaded.push({ src: data.url, alt: "", caption: "" });
        setLibrary((prev) => [{ url: data.url as string, filename: file.name }, ...prev]);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (uploaded.length) emit([...items, ...uploaded]);
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <span style={fieldLabel}>{label}</span>
      {help ? <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: "0 0 0.75rem" }}>{help}</p> : null}
      {items.map((item, index) => (
        <div key={`${item.src}-${index}`} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, padding: "0.6rem", marginBottom: "0.5rem" }}>
          {item.src ? (
            <img src={item.src} alt="" style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 4, marginBottom: "0.4rem" }} />
          ) : null}
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder={t("builder.inspector.placeholder.imageUrl")}
            value={item.src}
            onChange={(e) => emit(items.map((row, i) => (i === index ? { ...row, src: e.target.value } : row)))}
          />
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder={t("builder.inspector.field.altText")}
            value={item.alt}
            onChange={(e) => emit(items.map((row, i) => (i === index ? { ...row, alt: e.target.value } : row)))}
          />
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder={t("builder.inspector.field.caption")}
            value={item.caption}
            onChange={(e) => emit(items.map((row, i) => (i === index ? { ...row, caption: e.target.value } : row)))}
          />
          <button type="button" onClick={() => emit(items.filter((_, i) => i !== index))} style={{ color: "var(--jf-danger)", background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer" }}>
            {t("builder.inspector.remove")}
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "var(--jf-surface)", cursor: uploading ? "default" : "pointer", fontSize: "0.8rem", marginBottom: "0.4rem" }}
      >
        {uploading ? t("builder.inspector.images.uploading") : t("builder.inspector.images.uploadFromDevice")}
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
      <button type="button" onClick={() => addUrl("")} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "var(--jf-surface)", cursor: "pointer", fontSize: "0.8rem", marginBottom: "0.4rem" }}>
        {t("builder.inspector.images.addImageUrl")}
      </button>
      <button type="button" onClick={loadLibrary} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "var(--jf-surface)", cursor: "pointer", fontSize: "0.8rem" }}>
        {t("builder.inspector.images.addFromMediaLibrary")}
      </button>
      {showLibrary && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem", marginTop: "0.5rem", maxHeight: 180, overflow: "auto" }}>
          {library.length === 0 ? (
            <p style={{ color: "var(--jf-text-3)", fontSize: "0.75rem", gridColumn: "1 / -1" }}>{t("builder.inspector.images.noImagesYet")}</p>
          ) : library.map((file) => (
            <button
              key={file.url}
              type="button"
              onClick={() => addUrl(file.url)}
              style={{ padding: 0, border: "1px solid var(--jf-border)", borderRadius: 4, overflow: "hidden", cursor: "pointer", background: "var(--jf-surface)" }}
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
