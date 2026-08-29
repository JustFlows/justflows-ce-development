import { useEffect, useRef, useState } from "react";
import type { BlockNode, BlockCatalogEntry } from "./types";
import { syncColumnCount } from "./block-defaults";
import AnimationPanel from "./AnimationPanel";
import BlockStylePanel from "./BlockStylePanel";
import BlockJsonPanel from "./BlockJsonPanel";
import GridPlacementPanel from "./GridPlacementPanel";
import BlockLayoutPanel from "./BlockLayoutPanel";
import ReusablePanel, { type ReusableItem } from "./ReusablePanel";
import { GRID_BLOCK_TYPE } from "./grid";
import MediaImageField from "../MediaImageField";
import { PRODUCT_TAG_INSERTS } from "../../lib/product-tags";

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

function textToSections(text: string): Array<{ name: string; items: string[] }> {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((chunk) => {
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      return {
        name: (lines[0] ?? "Details").replace(/:$/, ""),
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
  enableProductTags?: boolean;
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
  enableProductTags = false,
}: BlockInspectorProps) {
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

  const productTagBar = (key: string) =>
    enableProductTags ? (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", margin: "-0.35rem 0 0.75rem" }}>
        {PRODUCT_TAG_INSERTS.map((item) => (
          <button
            key={item.tag}
            type="button"
            className="jf-btn jf-btn--ghost"
            style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
            onClick={() => insertTag(key, item.tag)}
          >
            {item.tag}
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
        {select("background", "Background", [
          { value: "default", label: "Default" },
          { value: "muted", label: "Muted" },
          { value: "primary", label: "Primary tint" },
          { value: "dark", label: "Dark" },
          { value: "gradient", label: "Gradient" },
        ])}
        {select("padding", "Padding", [
          { value: "sm", label: "Small" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Large" },
          { value: "xl", label: "Extra large" },
        ])}
        {select("align", "Alignment", [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
        ])}
      </>;
      break;

    case "core.container":
      fields = select("width", "Width", [
        { value: "narrow", label: "Narrow" },
        { value: "default", label: "Default" },
        { value: "wide", label: "Wide" },
        { value: "full", label: "Full" },
      ]);
      break;

    case "core.columns":
      fields = <>
        <label style={fieldLabel}>Columns
          <input type="number" style={fieldInput} min={2} max={4} value={(p.columns as number) ?? 2} onChange={(e) => set("columns", Number(e.target.value))} />
        </label>
        {select("gap", "Gap", [
          { value: "sm", label: "Small" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Large" },
        ])}
      </>;
      break;

    case "core.hero":
      fields = <>
        {textInput("heading", "Heading")}
        {textArea("subheading", "Subheading", 2)}
        {textInput("buttonLabel", "Button label")}
        <InternalLinkField value={(p.buttonUrl as string) ?? ""} onChange={(url) => set("buttonUrl", url)} label="Button URL" placeholder="/about or https://…" />
        {textInput("backgroundImage", "Background image URL")}
        {select("align", "Alignment", [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
        ])}
      </>;
      break;

    case "core.features":
      fields = <FeaturesEditor items={(p.items as FeatureItem[]) ?? []} heading={(p.heading as string) ?? ""} columns={(p.columns as number) ?? 3} onChange={onChange} p={p} />;
      break;

    case "core.cta":
      fields = <>
        {textInput("heading", "Heading")}
        {textArea("text", "Text", 2)}
        {textInput("buttonLabel", "Button label")}
        <InternalLinkField value={(p.buttonUrl as string) ?? ""} onChange={(url) => set("buttonUrl", url)} label="Button URL" />
        {select("variant", "Style", [
          { value: "primary", label: "Primary" },
          { value: "dark", label: "Dark" },
        ])}
      </>;
      break;

    case "core.paragraph": fields = textArea("text", "Text", 5, true); break;
    case "core.heading":
      fields = <>
        {textInput("text", "Heading text", "", true)}
        <label style={fieldLabel}>Level
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
          label="Image"
          value={(p.src as string) ?? ""}
          onChange={(url) => set("src", url)}
        />
        {textInput("alt", "Alt text")}
        {textInput("caption", "Caption")}
        <div className="jf-block-panel__grid2">
          <label className="jf-block-panel__field jf-block-panel__field--inline">Width (px)
            <input type="number" min={0} max={10000} placeholder="Auto" value={(p.width as number) || ""} onChange={(e) => set("width", Number(e.target.value) || 0)} />
          </label>
          <label className="jf-block-panel__field jf-block-panel__field--inline">Height (px)
            <input type="number" min={0} max={10000} placeholder="Auto" value={(p.height as number) || ""} onChange={(e) => set("height", Number(e.target.value) || 0)} />
          </label>
        </div>
        {select("objectFit", "Image fit", [
          { value: "contain", label: "Contain" },
          { value: "cover", label: "Cover" },
          { value: "fill", label: "Stretch" },
        ])}
      </>;
      break;
    case "core.quote":
      fields = <>{textArea("text", "Quote", 3)}{textInput("attribution", "Attribution")}</>;
      break;
    case "core.button":
      fields = <>
        {textInput("label", "Label")}
        <InternalLinkField value={(p.url as string) ?? ""} onChange={(url) => set("url", url)} label="URL" />
        {select("variant", "Variant", [
          { value: "primary", label: "Primary" },
          { value: "secondary", label: "Secondary" },
          { value: "outline", label: "Outline" },
        ])}
      </>;
      break;
    case "core.link-list":
      fields = <LinkListEditor items={(p.items as LinkItem[]) ?? []} heading={(p.heading as string) ?? ""} onChange={onChange} p={p} />;
      break;
    case "core.spacer":
      fields = (
        <label style={fieldLabel}>Height (px)
          <input type="number" style={fieldInput} min={8} max={500} value={(p.height as number) ?? 40} onChange={(e) => set("height", Number(e.target.value))} />
        </label>
      );
      break;
    case "core.code":
      fields = <>{textArea("code", "Code", 8)}{textInput("language", "Language")}</>;
      break;
    case "core.embed": fields = textInput("url", "URL"); break;
    case "core.html": fields = textArea("html", "HTML", 6, true); break;
    case "core.divider":
      fields = <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>No settings.</p>;
      break;
    case "core.color-scheme":
      fields = <>
        {select("style", "Style", [
          { value: "buttons", label: "Buttons" },
          { value: "icons", label: "Icons" },
        ])}
        {select("align", "Alignment", [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ])}
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showSystem === true} onChange={(e) => set("showSystem", e.target.checked)} />
          Show an “Auto” option
        </label>
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          Visitors who have not chosen already follow their device setting. Auto lets them go back to it.
        </p>
      </>;
      break;
    case "core.language-switcher":
      fields = <>
        {select("style", "Style", [
          { value: "codes", label: "Language codes" },
          { value: "names", label: "Language names" },
        ])}
        {select("align", "Alignment", [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ])}
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>Shown when the site has more than one active language.</p>
      </>;
      break;
    case "core.auth-links":
      fields = <>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showLogin !== false} onChange={(e) => set("showLogin", e.target.checked)} />
          Show login
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showRegister !== false} onChange={(e) => set("showRegister", e.target.checked)} />
          Show register
        </label>
        {textInput("loginLabel", "Login label")}
        {textInput("registerLabel", "Register label")}
        {select("style", "Style", [
          { value: "buttons", label: "Buttons" },
          { value: "links", label: "Links" },
        ])}
        {select("align", "Alignment", [
          { value: "left", label: "Left" },
          { value: "center", label: "Center" },
          { value: "right", label: "Right" },
        ])}
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          Register is shown on the public site only when Settings → Anyone can register is on.
        </p>
      </>;
      break;
    case "core.group":
    case "core.column":
      fields = <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>Add content blocks inside this container.</p>;
      break;
    case "justflows.forms.form":
      fields = <FormBlockPicker formId={String(p.formId ?? "contact")} onChange={(formId) => set("formId", formId)} />;
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
        {select("layout", "Layout", [
          { value: "grid", label: "Grid" },
          { value: "list", label: "List" },
        ])}
        <label style={fieldLabel}>Columns (grid layout)
          <input type="number" style={fieldInput} min={1} max={4} value={(p.columns as number) ?? 3} onChange={(e) => set("columns", Number(e.target.value))} />
        </label>
        <label style={fieldLabel}>Posts per page
          <input
            type="number"
            style={fieldInput}
            min={0}
            max={100}
            placeholder="Use site default"
            value={(p.postsPerPage as number) || ""}
            onChange={(e) => set("postsPerPage", e.target.value === "" ? 0 : Number(e.target.value))}
          />
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showFeaturedImage !== false} onChange={(e) => set("showFeaturedImage", e.target.checked)} />
          Show featured image
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showDate !== false} onChange={(e) => set("showDate", e.target.checked)} />
          Show date
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showExcerpt !== false} onChange={(e) => set("showExcerpt", e.target.checked)} />
          Show excerpt
        </label>
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
          Lists published posts, newest first. Pagination uses /page/2, /page/3, etc. under this page's URL.
        </p>
      </>;
      break;
    case "justflows.shop.gallery":
      fields = <>
        {select("layout", "Layout", [
          { value: "thumbs", label: "Thumbnails" },
          { value: "featured", label: "Featured + two" },
          { value: "mosaic", label: "Mosaic" },
          { value: "single", label: "Single image" },
        ])}
        <label style={fieldLabel}>Images
          <textarea
            rows={6}
            style={fieldInput}
            value={linesOf(p.images, ["src", "alt"])}
            onChange={(e) => set("images", parsePipes(e.target.value, ["src", "alt"]))}
          />
          <span style={fieldHint}>One image per line: URL | alt text</span>
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.lightbox !== false} onChange={(e) => set("lightbox", e.target.checked)} />
          Lightbox
        </label>
      </>;
      break;
    case "justflows.shop.buy-box":
      fields = <>
        {textInput("title", "Title", "{{title}}", true)}
        {textInput("price", "Price", "{{price}}", true)}
        {textInput("comparePrice", "Compare at price", "{{comparePrice}}", true)}
        {textArea("description", "Description", 3, true)}
        {textInput("meta", "Meta", "SKU {{sku}}", true)}
        {textArea("attributes", "Options", 3, true)}
        {textInput("cartLabel", "Add to cart label")}
        {textInput("cartUrl", "Add to cart URL", "/cart")}
        {textInput("stockNote", "Stock note")}
        {textInput("shipping", "Shipping line", "", true)}
        {textInput("guarantee", "Guarantee")}
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showRating === true} onChange={(e) => set("showRating", e.target.checked)} />
          Show rating
        </label>
        {p.showRating === true ? (
          <>
            <label style={fieldLabel}>Average (0–5)
              <input type="number" style={fieldInput} min={0} max={5} step={0.5} value={Number(p.ratingAverage) || 0} onChange={(e) => set("ratingAverage", Number(e.target.value))} />
            </label>
            {textInput("reviewCount", "Review count label")}
          </>
        ) : null}
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showWishlist === true} onChange={(e) => set("showWishlist", e.target.checked)} />
          Show wishlist link
        </label>
      </>;
      break;
    case "justflows.shop.breadcrumbs":
      fields = <>
        {textInput("current", "Current page", "{{title}}", true)}
        <label style={fieldLabel}>Trail
          <textarea
            rows={3}
            style={fieldInput}
            value={linesOf(p.items, ["name", "href"])}
            onChange={(e) => set("items", parsePipes(e.target.value, ["name", "href"]))}
          />
          <span style={fieldHint}>One crumb per line: name | /path</span>
        </label>
      </>;
      break;
    case "justflows.shop.highlights":
      fields = <>
        {textInput("heading", "Heading")}
        <label style={fieldLabel}>Items
          <textarea
            rows={5}
            style={fieldInput}
            value={Array.isArray(p.items) ? (p.items as string[]).join("\n") : String(p.items ?? "")}
            onChange={(e) => set("items", e.target.value.split("\n").map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean))}
          />
        </label>
      </>;
      break;
    case "justflows.shop.accordion":
      fields = (
        <label style={fieldLabel}>Sections
          <textarea
            rows={10}
            style={fieldInput}
            value={sectionsToText(p.sections)}
            onChange={(e) => set("sections", textToSections(e.target.value))}
          />
          <span style={fieldHint}>Heading, then bullets. Blank line starts a new section.</span>
        </label>
      );
      break;
    case "justflows.shop.policies":
      fields = (
        <label style={fieldLabel}>Policies
          <textarea
            rows={6}
            style={fieldInput}
            value={linesOf(p.items, ["name", "description", "imageSrc"])}
            onChange={(e) => set("items", parsePipes(e.target.value, ["name", "description", "imageSrc"]))}
          />
          <span style={fieldHint}>One card per line: name | description | icon URL</span>
        </label>
      );
      break;
    case "justflows.shop.reviews":
      fields = <>
        {textInput("heading", "Heading")}
        <label style={fieldLabel}>Average (0–5)
          <input type="number" style={fieldInput} min={0} max={5} step={0.5} value={Number(p.average) || 0} onChange={(e) => set("average", Number(e.target.value))} />
        </label>
        <label style={fieldLabel}>Total reviews
          <input type="number" style={fieldInput} min={0} value={Number(p.totalCount) || 0} onChange={(e) => set("totalCount", Number(e.target.value))} />
        </label>
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.showHistogram === true} onChange={(e) => set("showHistogram", e.target.checked)} />
          Show rating breakdown
        </label>
        <label style={fieldLabel}>Breakdown
          <textarea
            rows={5}
            style={fieldInput}
            value={Array.isArray(p.counts) ? (p.counts as Array<{ rating: number; count: number }>).map((row) => `${row.rating}:${row.count}`).join("\n") : String(p.counts ?? "")}
            onChange={(e) => set("counts", e.target.value.split("\n").map((line) => {
              const [rating, count] = line.split(/[:|]/);
              return { rating: Number(rating) || 0, count: Number(count) || 0 };
            }).filter((row) => row.rating > 0))}
          />
          <span style={fieldHint}>One row per rating: 5:12</span>
        </label>
        <label style={fieldLabel}>Featured reviews
          <textarea
            rows={6}
            style={fieldInput}
            value={linesOf(p.items, ["rating", "author", "title", "content", "avatarSrc"])}
            onChange={(e) => set("items", parsePipes(e.target.value, ["rating", "author", "title", "content", "avatarSrc"]))}
          />
          <span style={fieldHint}>rating | author | title | content | avatar URL</span>
        </label>
        {textInput("writeLabel", "Write review label")}
        {textInput("writeHref", "Write review URL")}
      </>;
      break;
    case "justflows.shop.related":
      fields = <>
        {textInput("heading", "Heading")}
        {select("layout", "Layout", [
          { value: "cards", label: "Cards" },
          { value: "overlay", label: "Overlay" },
        ])}
        <label style={fieldLabel}>Products
          <textarea
            rows={6}
            style={fieldInput}
            value={linesOf(p.items, ["imageSrc", "name", "price", "href", "color"])}
            onChange={(e) => set("items", parsePipes(e.target.value, ["imageSrc", "name", "price", "href", "color"]))}
          />
          <span style={fieldHint}>image URL | name | price | link | color</span>
        </label>
      </>;
      break;
    case "justflows.shop.product-list":
      fields = <>
        {select("layout", "Layout", [
          { value: "inline", label: "Inline price" },
          { value: "cta", label: "CTA link" },
          { value: "swatches", label: "Color swatches" },
          { value: "tall", label: "Tall images" },
          { value: "overlay", label: "Overlay + add button" },
          { value: "simple", label: "Simple" },
          { value: "favorites", label: "Tall images + CTA" },
          { value: "border", label: "Border grid" },
          { value: "supporting", label: "Supporting text" },
          { value: "hover", label: "Hover CTA" },
          { value: "cards", label: "Detail cards" },
        ])}
        {textInput("heading", "Heading")}
        <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
          <input type="checkbox" checked={p.headingHidden === true} onChange={(e) => set("headingHidden", e.target.checked)} />
          Hide heading
        </label>
        {textInput("ctaLabel", "Collection link label")}
        {textInput("ctaHref", "Collection link URL", "/shop")}
        {String(p.layout) === "overlay" ? textInput("addLabel", "Add button label") : null}
        <label style={fieldLabel}>Products
          <textarea
            rows={8}
            style={fieldInput}
            value={productListLines(p.items)}
            onChange={(e) => set("items", parsePipes(e.target.value, ["imageSrc", "name", "price", "href", "color", "description", "rating", "reviewCount", "colors"]))}
          />
          <span style={fieldHint}>image URL | name | price | link | color | description | rating | reviews | Black:#111827,White:#F9FAFB</span>
        </label>
      </>;
      break;
    case "justflows.shop.detail-shots":
      fields = <>
        {textInput("heading", "Heading")}
        {textArea("intro", "Intro", 3)}
        <label style={fieldLabel}>Shots
          <textarea
            rows={5}
            style={fieldInput}
            value={linesOf(p.items, ["src", "alt", "text"])}
            onChange={(e) => set("items", parsePipes(e.target.value, ["src", "alt", "text"]))}
          />
          <span style={fieldHint}>image URL | alt | caption</span>
        </label>
      </>;
      break;
    default:
      fields = <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>No settings for this block.</p>;
  }

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: "0.75rem", color: "var(--jf-text-3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "0.75rem" }}>
        {catalogEntry?.icon} {catalogEntry?.title ?? block.type}
      </div>
      {fields}
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
    onChange({ ...p, items: [...items, { icon: "✦", title: "New feature", description: "" }] });
    setOpen(items.length);
  }

  function removeItem(i: number) {
    onChange({ ...p, items: items.filter((_, idx) => idx !== i) });
  }

  return (
    <>
      <label style={fieldLabel}>Section heading
        <input type="text" style={fieldInput} value={heading} onChange={(e) => onChange({ ...p, heading: e.target.value })} />
      </label>
      <label style={fieldLabel}>Columns
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
              {item.icon} {item.title || `Feature ${i + 1}`}
            </button>
            {open === i && (
              <div style={{ padding: "0.75rem" }}>
                <label style={fieldLabel}>Icon
                  <input type="text" style={fieldInput} value={item.icon} onChange={(e) => updateItem(i, { icon: e.target.value })} />
                </label>
                <label style={fieldLabel}>Title
                  <input type="text" style={fieldInput} value={item.title} onChange={(e) => updateItem(i, { title: e.target.value })} />
                </label>
                <label style={fieldLabel}>Description
                  <textarea rows={2} style={fieldInput} value={item.description} onChange={(e) => updateItem(i, { description: e.target.value })} />
                </label>
                <button type="button" onClick={() => removeItem(i)} style={{ color: "var(--jf-danger)", background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer" }}>Remove</button>
              </div>
            )}
          </div>
        ))}
        <button type="button" onClick={addItem} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}>
          + Add feature
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
function InternalLinkField({ value, onChange, label = "URL", placeholder = "/about or https://…" }: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) {
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
      {label}
      <div style={{ display: "flex", gap: "0.35rem" }}>
        <input
          type="text"
          style={{ ...fieldInput, flex: 1 }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          onClick={togglePicker}
          title="Pick a page or post on this site"
          aria-label="Pick a page or post on this site"
          style={{ padding: "0 0.6rem", border: "1px solid var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.9rem" }}
        >
          {loading ? "…" : "📄"}
        </button>
      </div>
      {open && (
        <div style={{ border: "1px solid var(--jf-border)", borderRadius: 6, maxHeight: 220, overflow: "auto", background: "#fff" }}>
          {options.length === 0 ? (
            <div style={{ padding: "0.5rem 0.6rem", fontSize: "0.75rem", color: "var(--jf-text-3)" }}>No published pages or posts yet.</div>
          ) : (
            options.map((item) => (
              <button
                key={`${item.type}-${item.id}`}
                type="button"
                onClick={() => { onChange(`/${item.slug}`); setOpen(false); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "0.4rem 0.6rem", border: "none", borderBottom: "1px solid var(--jf-border)", background: "none", cursor: "pointer", fontSize: "0.8rem" }}
              >
                <span style={{ color: "var(--jf-text-3)", marginRight: "0.35rem" }}>{item.type === "page" ? "📄" : "📝"}</span>
                {item.title || `(untitled ${item.type})`}
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
  function updateItem(i: number, patch: Partial<LinkItem>) {
    const next = items.map((item, idx) => (idx === i ? { ...item, ...patch } : item));
    onChange({ ...p, items: next });
  }

  function addItem() {
    onChange({ ...p, items: [...items, { label: "New link", url: "/" }] });
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
      <label style={fieldLabel}>Heading (optional)
        <input type="text" style={fieldInput} placeholder="e.g. Product" value={heading} onChange={(e) => onChange({ ...p, heading: e.target.value })} />
      </label>
      <div style={{ marginTop: "0.5rem" }}>
        {items.map((item, i) => (
          <div key={i} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, marginBottom: "0.5rem", padding: "0.6rem" }}>
            <label style={fieldLabel}>Label
              <input type="text" style={fieldInput} value={item.label} onChange={(e) => updateItem(i, { label: e.target.value })} />
            </label>
            <InternalLinkField value={item.url} onChange={(url) => updateItem(i, { url })} />
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" onClick={() => moveItem(i, -1)} disabled={i === 0} style={{ background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer", color: "var(--jf-text-2)" }}>↑ Move up</button>
              <button type="button" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1} style={{ background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer", color: "var(--jf-text-2)" }}>↓ Move down</button>
              <button type="button" onClick={() => removeItem(i)} style={{ background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer", color: "var(--jf-danger)", marginLeft: "auto" }}>Remove</button>
            </div>
          </div>
        ))}
        <button type="button" onClick={addItem} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}>
          + Add link
        </button>
      </div>
    </>
  );
}

function FormBlockPicker({ formId, onChange }: { formId: string; onChange: (formId: string) => void }) {
  const [forms, setForms] = useState<Array<{ id: string; name: string }>>([]);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    fetch("/api/forms")
      .then((r) => r.json())
      .then((body: { enabled?: boolean; forms?: Array<{ id: string; data?: { name?: string } }> }) => {
        setEnabled(body.enabled !== false);
        setForms((body.forms ?? []).map((form) => ({ id: form.id, name: form.data?.name ?? form.id })));
      })
      .catch(() => setForms([]));
  }, []);

  if (!enabled) {
    return <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>Install and keep the Forms plugin available to use this block.</p>;
  }

  return (
    <>
      <label style={fieldLabel}>
        Form
        <select style={fieldInput} value={formId} onChange={(e) => onChange(e.target.value)}>
          {forms.map((form) => (
            <option key={form.id} value={form.id}>{form.name}</option>
          ))}
        </select>
      </label>
      <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: 0 }}>
        Edit fields under Extensions → Forms.
      </p>
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
        if (!res.ok || !data.url) throw new Error(data.error ?? "Upload failed");
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
        Layout
        <select style={fieldInput} value={layout} onChange={(e) => emit({ layout: e.target.value })}>
          <option value="grid">Grid</option>
          <option value="masonry">Masonry</option>
          <option value="carousel">Carousel</option>
          <option value="slideshow">Slideshow (fade)</option>
          <option value="list">List</option>
        </select>
      </label>
      {(layout === "grid" || layout === "masonry") && (
        <label style={fieldLabel}>
          Columns
          <input type="number" min={2} max={6} style={fieldInput} value={columns} onChange={(e) => emit({ columns: Number(e.target.value) })} />
        </label>
      )}
      {(layout === "carousel" || layout === "slideshow") && (
        <p style={{ color: "var(--jf-text-3)", fontSize: "0.8rem", margin: "0 0 0.75rem" }}>
          One image shown at a time, with dots to jump between them. Reorder images below to change the order.
        </p>
      )}
      <label style={{ ...fieldLabel, flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
        <input type="checkbox" checked={lightbox} onChange={(e) => emit({ lightbox: e.target.checked })} />
        Lightbox
      </label>

      {items.map((item, index) => (
        <div key={`${item.src}-${index}`} style={{ border: "1px solid var(--jf-border)", borderRadius: 6, padding: "0.6rem", marginBottom: "0.5rem" }}>
          {item.src ? (
            <img src={item.src} alt="" style={{ width: "100%", height: 72, objectFit: "cover", borderRadius: 4, marginBottom: "0.4rem" }} />
          ) : null}
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder="Image URL"
            value={item.src}
            onChange={(e) => emit({ items: items.map((row, i) => (i === index ? { ...row, src: e.target.value } : row)) })}
          />
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder="Alt text"
            value={item.alt}
            onChange={(e) => emit({ items: items.map((row, i) => (i === index ? { ...row, alt: e.target.value } : row)) })}
          />
          <input
            style={{ ...fieldInput, marginBottom: "0.35rem" }}
            placeholder="Caption"
            value={item.caption}
            onChange={(e) => emit({ items: items.map((row, i) => (i === index ? { ...row, caption: e.target.value } : row)) })}
          />
          <button type="button" onClick={() => emit({ items: items.filter((_, i) => i !== index) })} style={{ color: "var(--jf-danger)", background: "none", border: "none", fontSize: "0.75rem", cursor: "pointer" }}>
            Remove
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: uploading ? "default" : "pointer", fontSize: "0.8rem", marginBottom: "0.4rem" }}
      >
        {uploading ? "Uploading…" : "⇧ Upload from device"}
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
        + Add image URL
      </button>
      <button type="button" onClick={loadLibrary} style={{ width: "100%", padding: "0.4rem", border: "1px dashed var(--jf-border-strong)", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: "0.8rem" }}>
        Add from media library
      </button>
      {showLibrary && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.35rem", marginTop: "0.5rem", maxHeight: 180, overflow: "auto" }}>
          {library.length === 0 ? (
            <p style={{ color: "var(--jf-text-3)", fontSize: "0.75rem", gridColumn: "1 / -1" }}>No images in the media library yet.</p>
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
