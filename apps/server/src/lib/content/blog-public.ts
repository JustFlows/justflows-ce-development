// SPDX-License-Identifier: MIT

import { contentPermalinks } from "../navigation/permalinks-db.js";
import { esc, renderResponsiveImage, safeMediaSrc } from "@justflows/blocks";
import { getRuntimeBlockRegistry } from "../rendering/runtime-blocks.js";
import { listPublishedPostsPage } from "./content-public.js";
import { formatContentDate } from "../settings/general-settings.js";
import {
  applyResponsiveProp,
  loadResponsiveProps,
  type ResponsiveProp,
} from "../media/responsive-media.js";
import type { ContentResponse } from "./content-api.js";
import { placeholderImgHtml } from "@justflows/plugin-api";
import type { PlaceholderImage } from "@justflows/sdk";
import { resolvePlaceholder } from "../media/placeholders.js";

export const BLOG_POST_LIST_BLOCK_TYPE = "justflows.blog.postList";

export type BlogPostListLayout = "list" | "grid";

const LAYOUTS: BlogPostListLayout[] = ["list", "grid"];

export interface BlogPostListProps {
  layout: BlogPostListLayout;
  columns: number;
  showExcerpt: boolean;
  showDate: boolean;
  showFeaturedImage: boolean;
  /** Show the thumbnail placeholder for posts without a featured image. */
  showPlaceholder: boolean;
  postsPerPage: number | null;
}

export function parseBlogPostListProps(raw: unknown): BlogPostListProps {
  const row = (raw ?? {}) as Record<string, unknown>;
  const layout: BlogPostListLayout = LAYOUTS.includes(row.layout as BlogPostListLayout)
    ? (row.layout as BlogPostListLayout)
    : "grid";
  const rawColumns = Number(row.columns);
  const columns = Math.min(
    4,
    Math.max(1, Number.isFinite(rawColumns) && rawColumns > 0 ? rawColumns : 3),
  );
  // 0 (and unset/blank) mean "use the site's posts_per_page setting" — the
  // sentinel the block picker's number field and the admin inspector both use.
  const rawPostsPerPage = Number(row.postsPerPage);
  const postsPerPage =
    Number.isFinite(rawPostsPerPage) && rawPostsPerPage > 0
      ? Math.min(100, Math.max(1, rawPostsPerPage))
      : null;
  return {
    layout,
    columns,
    showExcerpt: row.showExcerpt !== false && row.showExcerpt !== "false",
    showDate: row.showDate !== false && row.showDate !== "false",
    showFeaturedImage: row.showFeaturedImage !== false && row.showFeaturedImage !== "false",
    showPlaceholder: row.showPlaceholder !== false && row.showPlaceholder !== "false",
    postsPerPage,
  };
}

export interface BlogPostListRenderContext {
  siteId: string;
  locale: string;
  defaultLocale: string;
  /** 1-based current page number, from the `/page/:num` route. */
  page: number;
  /** Permalink of the page this block is rendered on, used to build `/page/N` links. */
  basePath: string;
  /** Falls back to the site's `posts_per_page` setting when the block has no override. */
  postsPerPageDefault: number;
}

/** The raw stored featured-image URL (matches `media.url` for responsive lookup). */
function featuredImageRawOf(post: ContentResponse): string {
  const raw = post.fields?.seoImage;
  return typeof raw === "string" ? raw : "";
}

function featuredSizes(props: BlogPostListProps): string {
  if (props.layout === "grid") {
    const pct = Math.max(20, Math.round(100 / Math.max(1, props.columns)));
    return `(max-width: 600px) 100vw, ${pct}vw`;
  }
  return "(max-width: 700px) 100vw, 320px";
}

function postListItemHtml(
  post: ContentResponse,
  props: BlogPostListProps,
  ctx: BlogPostListRenderContext,
  dateLabel: string,
  href: string,
  responsive?: Map<string, ResponsiveProp>,
  placeholder?: PlaceholderImage | null,
): string {
  const rawImage = props.showFeaturedImage ? featuredImageRawOf(post) : "";
  const image = rawImage ? safeMediaSrc(rawImage) : "";
  const imgHtml = image
    ? renderResponsiveImage(
        applyResponsiveProp(
          { src: image, alt: "", loading: "lazy", sizes: featuredSizes(props) },
          responsive?.get(rawImage),
        ),
      )
    : props.showFeaturedImage && placeholder
      ? placeholderImgHtml(placeholder)
      : "";
  const media = imgHtml
    ? `<a class="post-thumb" href="${esc(href)}" tabindex="-1" aria-hidden="true">${imgHtml}</a>`
    : "";
  const date = props.showDate && dateLabel ? `<p class="post-meta">${esc(dateLabel)}</p>` : "";
  const excerpt =
    props.showExcerpt && post.excerpt ? `<p class="post-excerpt">${esc(post.excerpt)}</p>` : "";
  return `<li class="post-list-item">
    ${media}
    <h3 class="post-title"><a href="${esc(href)}">${esc(post.title)}</a></h3>
    ${date}
    ${excerpt}
  </li>`;
}

/** WordPress-style numbered pager: first, a window around the current page, last, with ellipses. */
function paginationHtml(ctx: BlogPostListRenderContext, totalPages: number): string {
  if (totalPages <= 1) return "";
  const base = ctx.basePath === "/" ? "" : ctx.basePath.replace(/\/$/, "");
  const linkFor = (n: number) => (n <= 1 ? base || "/" : `${base}/page/${n}`);
  const current = ctx.page;

  const pageNumbers = new Set<number>([1, totalPages, current]);
  for (let n = current - 1; n <= current + 1; n++) {
    if (n >= 1 && n <= totalPages) pageNumbers.add(n);
  }
  const sorted = [...pageNumbers].sort((a, b) => a - b);

  const items: string[] = [];
  if (current > 1)
    items.push(`<a href="${esc(linkFor(current - 1))}" aria-label="Previous page">«</a>`);

  let last = 0;
  for (const n of sorted) {
    if (last && n - last > 1) items.push(`<span>…</span>`);
    items.push(
      n === current ? `<span class="current">${n}</span>` : `<a href="${esc(linkFor(n))}">${n}</a>`,
    );
    last = n;
  }

  if (current < totalPages)
    items.push(`<a href="${esc(linkFor(current + 1))}" aria-label="Next page">»</a>`);

  return `<nav class="pagination" aria-label="Blog pagination">${items.join("\n")}</nav>`;
}

export async function renderBlogPostListBlockHtml(
  rawProps: unknown,
  ctx: BlogPostListRenderContext,
): Promise<string> {
  const props = parseBlogPostListProps(rawProps);
  const limit = props.postsPerPage ?? ctx.postsPerPageDefault;
  const page = Math.max(1, ctx.page);
  const offset = (page - 1) * limit;

  const { items, total } = await listPublishedPostsPage(ctx.siteId, ctx.locale, { limit, offset });
  if (items.length === 0 && page === 1) {
    return `<p class="post-meta">No posts yet.</p>`;
  }

  const dateLabels = await Promise.all(
    items.map((post) =>
      props.showDate && post.publishedAt
        ? formatContentDate(post.publishedAt)
        : Promise.resolve(""),
    ),
  );

  const hrefs = await contentPermalinks(items);
  const responsive = props.showFeaturedImage
    ? await loadResponsiveProps(items.map(featuredImageRawOf).filter(Boolean), ctx.siteId)
    : undefined;
  const placeholder =
    props.showFeaturedImage && props.showPlaceholder && items.some((post) => !featuredImageRawOf(post))
      ? await resolvePlaceholder("featured", ctx.siteId)
      : null;
  const rows = items
    .map((post, i) =>
      postListItemHtml(post, props, ctx, dateLabels[i] ?? "", hrefs[i]!, responsive, placeholder),
    )
    .join("\n");
  const listClass =
    props.layout === "grid"
      ? `post-list post-list--grid post-list--cols-${props.columns}`
      : "post-list";
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return `<ul class="${listClass}">${rows}</ul>${paginationHtml(ctx, totalPages)}`;
}

/**
 * The block registry is a process-wide singleton. This block is core (not a
 * plugin), so it's registered once at process startup and never unregistered
 * — see `registerBlogPostListBlock` call site in public-site.ts.
 */
export function registerBlogPostListBlock(): void {
  const registry = getRuntimeBlockRegistry();
  if (registry.get(BLOG_POST_LIST_BLOCK_TYPE)) return;
  registry.register({
    type: BLOG_POST_LIST_BLOCK_TYPE,
    version: 1,
    title: "Post List",
    description:
      "Lists published blog posts, paginated. Drop it on any page to make that page a blog index.",
    icon: "📰",
    category: "content",
    schema: {
      layout: { type: "select", options: [...LAYOUTS], default: "grid" },
      columns: { type: "number", default: 3 },
      showExcerpt: { type: "boolean", default: true },
      showDate: { type: "boolean", default: true },
      showFeaturedImage: { type: "boolean", default: true },
      showPlaceholder: { type: "boolean", default: true },
      postsPerPage: { type: "number", default: 0 },
    },
    validateProps: (raw) => parseBlogPostListProps(raw) as unknown as Record<string, unknown>,
    render: () => `<p class="post-meta">Blog posts will appear here.</p>`,
  });
}
