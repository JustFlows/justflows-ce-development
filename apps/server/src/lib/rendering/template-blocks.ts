// SPDX-License-Identifier: MIT

/**
 * Context blocks — the Justflows equivalents of WordPress's Post Title / Post
 * Content / Featured Image / Template Part blocks. They carry no data of their
 * own; they render the *current request's* content when a theme template
 * (`templates/<slug>.json`) puts them on the page.
 *
 * Like `justflows.blog.postList` and the forms/comments blocks, these are
 * registered as builder stubs here and given their real server render in
 * `renderBlockTree` (public-site.ts) when a {@link TemplateBlockContext} is in
 * scope. Dropped on an ordinary page with no template context, they degrade to
 * an HTML comment rather than throwing.
 */

import { esc, type BlockDefinition } from "@justflows/blocks";
import { getRuntimeBlockRegistry } from "./runtime-blocks.js";
import { renderMediaImage } from "../media/responsive-media.js";
import { renderPlaceholder } from "../media/placeholders.js";
import type { TemplatePartSlot } from "./template-hierarchy.js";
import { TEMPLATE_PART_SLOTS } from "./template-hierarchy.js";
import { WIDGET_AREA_BLOCK_TYPE, WIDGET_AREA_KEY_RE } from "./widget-areas.js";

export const POST_TITLE_BLOCK_TYPE = "core.post-title";
export const POST_CONTENT_BLOCK_TYPE = "core.post-content";
export const POST_META_BLOCK_TYPE = "core.post-meta";
export const POST_EXCERPT_BLOCK_TYPE = "core.post-excerpt";
export const FEATURED_IMAGE_BLOCK_TYPE = "core.featured-image";
export const TEMPLATE_PART_BLOCK_TYPE = "core.template-part";
export { WIDGET_AREA_BLOCK_TYPE };

export const TEMPLATE_BLOCK_TYPES = new Set<string>([
  POST_TITLE_BLOCK_TYPE,
  POST_CONTENT_BLOCK_TYPE,
  POST_META_BLOCK_TYPE,
  POST_EXCERPT_BLOCK_TYPE,
  FEATURED_IMAGE_BLOCK_TYPE,
  TEMPLATE_PART_BLOCK_TYPE,
  WIDGET_AREA_BLOCK_TYPE,
]);

/** The subset of a content row a context block needs, plus render helpers. */
export interface TemplateBlockContext {
  content: {
    id: string;
    type: string;
    title: string;
    slug: string;
    excerpt: string | null;
    fields: Record<string, unknown>;
    publishedAt: string | null;
  } | null;
  /** Site-formatted publish date, or null when the row has none. */
  formattedDate: string | null;
  /** The content's own blocks, already rendered to HTML. */
  contentBodyHtml: string;
  /** Render a template part (`parts/<slug>.json`); "" when the theme ships none. */
  renderPart: (slug: TemplatePartSlot) => Promise<string>;
  /** Render a widget area (`<aside>` markup); "" when it is unknown or empty. */
  renderWidgetArea: (key: string) => Promise<string>;
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

function headingLevel(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(6, Math.max(1, Math.trunc(n))) : 1;
}

/** Raw stored featured-image URL; `renderMediaImage` sanitizes and resolves it. */
function featuredImageRaw(fields: Record<string, unknown>): string {
  const raw = fields.seoImage ?? fields.featuredImage;
  return typeof raw === "string" ? raw : "";
}

function partSlug(raw: unknown): TemplatePartSlot | null {
  return TEMPLATE_PART_SLOTS.includes(raw as TemplatePartSlot) ? (raw as TemplatePartSlot) : null;
}

/** Real server render for a context block; `renderBlockTree` calls this. */
export async function renderTemplateBlockHtml(
  type: string,
  rawProps: unknown,
  ctx: TemplateBlockContext,
): Promise<string> {
  const props = (rawProps ?? {}) as Record<string, unknown>;
  const content = ctx.content;

  switch (type) {
    case POST_CONTENT_BLOCK_TYPE: {
      // `wrap` reproduces the two shapes the built-in single.ejs used:
      // "post" → <div class="block-content">, "page" → adds block-content--page
      // (which neutralises section padding). "none" (default) emits bare blocks.
      const wrap = str(props.wrap);
      if (wrap === "post") return `<div class="block-content">${ctx.contentBodyHtml}</div>`;
      if (wrap === "page") {
        return `<div class="block-content block-content--page">${ctx.contentBodyHtml}</div>`;
      }
      return ctx.contentBodyHtml;
    }

    case POST_TITLE_BLOCK_TYPE: {
      if (!content?.title) return "";
      const level = headingLevel(props.level);
      return `<h${level} class="post-title">${esc(content.title)}</h${level}>`;
    }

    case POST_META_BLOCK_TYPE:
      return ctx.formattedDate ? `<p class="post-meta">${esc(ctx.formattedDate)}</p>` : "";

    case POST_EXCERPT_BLOCK_TYPE:
      return content?.excerpt ? `<p class="post-excerpt">${esc(content.excerpt)}</p>` : "";

    case FEATURED_IMAGE_BLOCK_TYPE: {
      const raw = content ? featuredImageRaw(content.fields) : "";
      const img = raw
        ? await renderMediaImage({
            url: raw,
            alt: content?.title ?? "",
            loading: "lazy",
            sizes: "(max-width: 1000px) 100vw, 1000px",
          })
        : // No entry (404, archive): nothing to stand in for.
          content && props.placeholder !== false && props.placeholder !== "false"
          ? await renderPlaceholder("featured")
          : "";
      return img ? `<figure class="post-featured-image">${img}</figure>` : "";
    }

    case TEMPLATE_PART_BLOCK_TYPE: {
      const slug = partSlug(props.slug);
      return slug ? await ctx.renderPart(slug) : "";
    }

    case WIDGET_AREA_BLOCK_TYPE: {
      const key = str(props.area);
      return WIDGET_AREA_KEY_RE.test(key) ? await ctx.renderWidgetArea(key) : "";
    }

    default:
      return "";
  }
}

/**
 * The block registry is a process-wide singleton; these are core blocks, so
 * they are registered once at startup (call site in public-site.ts) and never
 * unregistered. The stub `render` only shows when the block is used outside a
 * theme template.
 */
export function registerTemplateBlocks(): void {
  const registry = getRuntimeBlockRegistry();

  const defs: Array<Pick<BlockDefinition, "type" | "title" | "description" | "icon" | "schema">> = [
    {
      type: POST_TITLE_BLOCK_TYPE,
      title: "Post Title",
      description: "The current page or post's title. For use in a theme template.",
      icon: "T",
      schema: { level: { type: "number" as const, default: 1 } },
    },
    {
      type: POST_CONTENT_BLOCK_TYPE,
      title: "Post Content",
      description: "The current page or post's own blocks. For use in a theme template.",
      icon: "¶",
      schema: {
        wrap: {
          type: "select" as const,
          options: ["none", "post", "page"],
          default: "none",
        },
      },
    },
    {
      type: POST_META_BLOCK_TYPE,
      title: "Post Meta",
      description: "The current page or post's publish date. For use in a theme template.",
      icon: "🕒",
      schema: {},
    },
    {
      type: POST_EXCERPT_BLOCK_TYPE,
      title: "Post Excerpt",
      description: "The current page or post's excerpt. For use in a theme template.",
      icon: "…",
      schema: {},
    },
    {
      type: FEATURED_IMAGE_BLOCK_TYPE,
      title: "Featured Image",
      description: "The current page or post's featured image. For use in a theme template.",
      icon: "🖼",
      schema: {
        // Show the site's featured-image placeholder when the entry has no image.
        placeholder: {
          type: "boolean" as const,
          default: true,
          label: "Show placeholder when empty",
          help: "Uses the placeholder from Settings → Placeholders.",
        },
      },
    },
    {
      type: TEMPLATE_PART_BLOCK_TYPE,
      title: "Template Part",
      description: "Embeds a shared template part (header or footer).",
      icon: "▤",
      schema: {
        slug: { type: "select" as const, options: [...TEMPLATE_PART_SLOTS], default: "header" },
      },
    },
    {
      type: WIDGET_AREA_BLOCK_TYPE,
      title: "Widget Area",
      description: "Shows a widget area (such as the sidebar). For use in a theme template.",
      icon: "▥",
      schema: {
        area: { type: "text" as const, default: "sidebar", label: "Area key" },
      },
    },
  ];

  for (const def of defs) {
    if (registry.get(def.type)) continue;
    registry.register({
      ...def,
      version: 1,
      category: "content",
      validateProps: (raw) => (raw ?? {}) as Record<string, unknown>,
      render: () => `<!-- ${def.type}: only renders inside a theme template -->`,
    });
  }
}
