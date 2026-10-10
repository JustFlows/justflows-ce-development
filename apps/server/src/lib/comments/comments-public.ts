import { contentTypePolicy } from "@justflows/content";
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { esc, sanitizePlainText, sanitizeRichText } from "@justflows/blocks";
import type { CommentsBlockRenderContext, PublicComment } from "@justflows/sdk";
import { getDb } from "../database/db.js";
import { getRuntimeBlockRegistry } from "../rendering/runtime-blocks.js";
import { ensurePluginRuntime, getRuntimeHooks } from "../plugins/plugin-runtime.js";
import { consumeRateLimit } from "../security/rate-limit.js";
import { getGeneralSettings } from "../settings/general-settings.js";
import { getSiteId } from "../settings/site-settings.js";
import { commentsStateFor, getCommentSettings, type CommentSettings } from "./comments-settings.js";
import { CAPTCHA_META, renderCaptchaWidget, verifyCaptcha } from "../security/captcha.js";
import { createCommentFormToken, verifyCommentFormToken } from "./comment-form-token.js";
import { decide } from "./comments-spam-policy.js";
import type { FormTokenStatus } from "./comments-spam-score.js";

export const COMMENTS_BLOCK_TYPE = "justflows.comments.thread";
const RECAPTCHA_V3_ACTION = "justflows_comment_submit";

export { CAPTCHA_META };

// ─── Block props ────────────────────────────────────────────────────────────

export interface CommentsBlockProps {
  title: string;
  order: "oldest" | "newest";
}

export function parseCommentsBlockProps(raw: unknown): CommentsBlockProps {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    title: String(row.title ?? "Comments").slice(0, 120) || "Comments",
    order: row.order === "newest" ? "newest" : "oldest",
  };
}

/**
 * Core block, registered once at startup (see the call site in public-site.ts).
 * The real thread + form HTML is produced by renderCommentsBlockHtml on the
 * public render path, which has the per-request context; this static render is
 * only the page-builder placeholder.
 */
export function registerCommentsBlock(): void {
  const registry = getRuntimeBlockRegistry();
  if (registry.get(COMMENTS_BLOCK_TYPE)) return;
  registry.register({
    type: COMMENTS_BLOCK_TYPE,
    version: 1,
    title: "Comments",
    description:
      "Public comment thread and submission form. Drop it on a post to enable discussion.",
    icon: "💬",
    category: "content",
    schema: {
      title: { type: "text", default: "Comments" },
      order: { type: "select", options: ["oldest", "newest"], default: "oldest" },
    },
    validateProps: (raw) => parseCommentsBlockProps(raw) as unknown as Record<string, unknown>,
    render: () => `<p class="jf-comments__placeholder">Comments will appear here.</p>`,
  });
}

// ─── Public render ──────────────────────────────────────────────────────────

export type CommentsBannerState = "posted" | "pending" | "error" | "captcha" | "rate_limited";

export interface CommentsRenderContext {
  siteId: string;
  content: {
    id: string;
    type: string;
    slug?: string;
    publishedAt: Date | string | null;
    fields: unknown;
    /** So a comment left on one translation shows on every translation. */
    translationGroupId?: string | null;
  };
  currentUser?: { id: string; name: string; email: string } | null;
  /** Banner to show above the form after a redirect back from a submission. */
  banner?: CommentsBannerState | null;
  /** Comment id the visitor clicked "reply" on. */
  replyTo?: string | null;
  /** 1-based page of top-level comments. */
  page: number;
  /** Permalink of the page the block sits on, for reply / pagination links. */
  basePath: string;
  locale: string;
  t: (key: string) => string;
}

interface CommentRow {
  id: string;
  parent_id: string | null;
  author_name: string;
  author_url: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}

interface ThreadNode extends CommentRow {
  children: ThreadNode[];
}

/**
 * Every `content` row id that counts as "this post": the resolved row, its
 * translations (shared translation_group_id), and any other row with the same
 * type + slug. The last clause matters because the row the visitor's page
 * resolves to at read time is not always the exact row the submission form was
 * rendered against (locale fallback, a duplicate `en`/`en-US` row, preview vs
 * published) — matching the whole slug keeps an approved comment visible
 * regardless of which of those rows it was attached to.
 */
async function resolveContentGroupIds(
  db: Awaited<ReturnType<typeof getDb>>,
  siteId: string,
  content: CommentsRenderContext["content"],
): Promise<string[]> {
  const groupId = content.translationGroupId ?? "";
  const slug = content.slug ?? "";
  try {
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM content
        WHERE site_id = ?
          AND ( id = ?
                OR (? <> '' AND translation_group_id = ?)
                OR (? <> '' AND type = ? AND slug = ?) )`,
      [siteId, content.id, groupId, groupId, slug, content.type, slug],
    );
    const ids = rows.map((r) => String(r.id));
    return ids.length ? [...new Set([content.id, ...ids])] : [content.id];
  } catch {
    return [content.id];
  }
}

function buildThread(rows: CommentRow[]): ThreadNode[] {
  const byId = new Map<string, ThreadNode>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });
  const roots: ThreadNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Postgres returns TIMESTAMPTZ as a Date, MySQL/MariaDB as a string; normalise. */
function toIsoString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return String(value);
}

function formatWhen(value: unknown): string {
  const d = new Date(toIsoString(value));
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function authorLink(name: unknown, url: unknown, allowUrls: boolean): string {
  const safeName = esc(String(name ?? ""));
  if (!allowUrls || !url || typeof url !== "string") return safeName;
  let href = "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") href = parsed.toString();
  } catch {
    href = "";
  }
  if (!href) return safeName;
  return `<a href="${esc(href)}" rel="nofollow ugc noopener" target="_blank">${safeName}</a>`;
}

function renderNode(
  node: ThreadNode,
  ctx: CommentsRenderContext,
  settings: CommentSettings,
  accepting: boolean,
  depth: number,
): string {
  const clampedChildren =
    depth + 1 >= settings.threadMaxDepth ? flatten(node.children) : node.children;
  const childrenHtml = clampedChildren.length
    ? `<ol class="jf-comments__list jf-comments__list--replies">${clampedChildren
        .map((child) =>
          renderNode(child, ctx, settings, accepting, Math.min(depth + 1, settings.threadMaxDepth)),
        )
        .join("")}</ol>`
    : "";
  const createdAt = toIsoString(node.created_at);
  const when = formatWhen(node.created_at);
  const edited = node.edited_at
    ? ` <span class="jf-comment__edited">(${esc(ctx.t("comments.edited"))})</span>`
    : "";
  const replyLink = accepting
    ? ` · <a class="jf-comment__reply-link" href="${esc(replyUrl(ctx.basePath, node.id))}#jf-comment-form">${esc(
        ctx.t("comments.reply"),
      )}</a>`
    : "";
  return `<li class="jf-comment" id="jf-comment-${esc(node.id)}">
    <article class="jf-comment__body">
      <header class="jf-comment__meta">
        <span class="jf-comment__author">${authorLink(node.author_name, node.author_url, settings.allowUrls)}</span>
        ${when ? `<time datetime="${esc(createdAt)}">${esc(when)}</time>` : ""}${edited}${replyLink}
      </header>
      <div class="jf-comment__text">${String(node.body ?? "")}</div>
    </article>
    ${childrenHtml}
  </li>`;
}

function flatten(nodes: ThreadNode[]): ThreadNode[] {
  const out: ThreadNode[] = [];
  const walk = (list: ThreadNode[]) => {
    for (const n of list) {
      out.push({ ...n, children: [] });
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function replyUrl(basePath: string, commentId: string): string {
  const base = basePath || "/";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}reply=${encodeURIComponent(commentId)}`;
}

function pageUrl(basePath: string, page: number): string {
  const base = basePath || "/";
  const sep = base.includes("?") ? "&" : "?";
  return page <= 1 ? base : `${base}${sep}comment-page=${page}`;
}

function bannerHtml(ctx: CommentsRenderContext): string {
  if (!ctx.banner) return "";
  const key =
    ctx.banner === "posted"
      ? "comments.posted_ok"
      : ctx.banner === "pending"
        ? "comments.awaiting_moderation"
        : ctx.banner === "captcha"
          ? "comments.captcha_failed"
          : ctx.banner === "rate_limited"
            ? "comments.rate_limited"
            : "comments.error_generic";
  const tone = ctx.banner === "posted" || ctx.banner === "pending" ? "success" : "error";
  const role = tone === "success" ? "status" : "alert";
  // data-jf-toast lets the global toast script (site-toast.js, every public
  // page) turn this into a floating, dismissible notice instead of a static
  // block a visitor might submit the form again without ever scrolling to see.
  return `<p class="jf-comments__banner jf-comments__banner--${tone}" role="${role}" data-jf-toast="${tone}">${esc(ctx.t(key))}</p>`;
}

function fieldRow(id: string, label: string, control: string, hint = ""): string {
  return `<p class="jf-comments__field">
    <label for="${id}">${esc(label)}</label>
    ${control}
    ${hint ? `<span class="jf-comments__hint">${esc(hint)}</span>` : ""}
  </p>`;
}

function formHtml(ctx: CommentsRenderContext, settings: CommentSettings): string {
  const user = ctx.currentUser ?? null;
  // A missing/short APP_SECRET must not take down the whole comments block —
  // an absent token is already a handled case (a "missing" spam signal).
  let formToken = "";
  try {
    formToken = createCommentFormToken({ contentId: ctx.content.id, siteId: ctx.siteId });
  } catch {
    formToken = "";
  }
  const nameControl = user
    ? `<input id="jf-comment-name" type="text" name="author_name" value="${esc(user.name)}" readonly>`
    : `<input id="jf-comment-name" type="text" name="author_name" maxlength="120" required autocomplete="name">`;
  const emailControl = user
    ? `<input id="jf-comment-email" type="email" name="author_email" value="${esc(user.email)}" readonly>`
    : `<input id="jf-comment-email" type="email" name="author_email" maxlength="320" autocomplete="email">`;

  const replyingTo = ctx.replyTo
    ? `<p class="jf-comments__replying">${esc(ctx.t("comments.replying"))}
        <a href="${esc(ctx.basePath || "/")}#jf-comment-form">${esc(ctx.t("comments.cancel_reply"))}</a></p>`
    : "";

  let captchaWidget = "";
  let captchaAttributes = "";
  if (settings.captchaProvider !== "none" && settings.captchaSiteKey) {
    const rendered = renderCaptchaWidget(settings.captchaProvider, settings.captchaSiteKey, {
      widgetClass: "jf-comments__captcha",
      recaptchaV3Action: RECAPTCHA_V3_ACTION,
    });
    captchaWidget = rendered.widget;
    captchaAttributes = rendered.formAttributes;
  }

  return `<form class="jf-comments__form" id="jf-comment-form" method="post" action="/justflows-comments/submit"${captchaAttributes}>
    <h3 class="jf-comments__form-title">${esc(ctx.t("comments.form_title"))}</h3>
    ${replyingTo}
    <input type="hidden" name="content_id" value="${esc(ctx.content.id)}">
    ${ctx.replyTo ? `<input type="hidden" name="parent_id" value="${esc(ctx.replyTo)}">` : ""}
    <input type="hidden" name="return_to" value="${esc(ctx.basePath || "/")}">
    <input type="hidden" name="form_token" value="${esc(formToken)}">
    <div class="jf-comments__hp" aria-hidden="true">
      <label for="jf-comment-url">Leave this field empty</label>
      <input id="jf-comment-url" type="text" name="website_url" tabindex="-1" autocomplete="off">
    </div>
    ${fieldRow("jf-comment-name", ctx.t("comments.name"), nameControl)}
    ${fieldRow("jf-comment-email", ctx.t("comments.email"), emailControl, ctx.t("comments.email_hint"))}
    ${
      settings.allowUrls
        ? fieldRow(
            "jf-comment-website",
            ctx.t("comments.website"),
            `<input id="jf-comment-website" type="url" name="author_url" maxlength="500" autocomplete="url">`,
          )
        : ""
    }
    ${fieldRow(
      "jf-comment-body",
      ctx.t("comments.message"),
      `<textarea id="jf-comment-body" name="body" rows="5" maxlength="${settings.maxLength}" required></textarea>`,
    )}
    <p class="jf-comments__field jf-comments__field--check">
      <label><input type="checkbox" name="notify" value="1"> ${esc(ctx.t("comments.notify_me"))}</label>
    </p>
    ${captchaWidget}
    <button type="submit" class="jf-comments__submit">${esc(ctx.t("comments.submit"))}</button>
  </form>`;
}

export async function renderCommentsBlockHtml(
  rawProps: unknown,
  ctx: CommentsRenderContext,
): Promise<string> {
  try {
    return await renderCommentsBlockHtmlInner(rawProps, ctx);
  } catch (err) {
    // A placed Comments block must never render as literally nothing — that is
    // impossible for an author to debug. Log it, leave a one-line HTML comment
    // for View-source diagnosis, and still render a valid (empty) section.
    console.error("[justflows] comments block render failed:", err);
    const t = ctx.t ?? ((k: string) => k);
    const reason = (err instanceof Error ? err.message : String(err))
      .slice(0, 200)
      .replace(/--+/g, "-");
    return `<section class="jf-comments" id="jf-comments">
      <!-- jf-comments render error: ${reason} -->
      <h2 class="jf-comments__heading">${esc(String(t("comments.heading") ?? "Comments"))}</h2>
      <p class="jf-comments__empty">${esc(String(t("comments.empty") ?? ""))}</p>
    </section>`;
  }
}

async function renderCommentsBlockHtmlInner(
  rawProps: unknown,
  ctx: CommentsRenderContext,
): Promise<string> {
  const props = parseCommentsBlockProps(rawProps);
  const settings = await getCommentSettings(ctx.siteId);
  const state = commentsStateFor(
    { fields: ctx.content.fields, publishedAt: ctx.content.publishedAt },
    settings,
  );
  if (!state.visible) return "";

  const db = await getDb();
  const pageSize = settings.pageSize;
  const page = Math.max(1, ctx.page || 1);

  // Bounded: fetch this content's approved comments in one pass, then page the
  // top-level nodes in memory so replies always render under their parent even
  // when the parent is on an earlier page. The per-content row count is what an
  // editor moderates, so the ceiling is generous rather than tight.
  const MAX_ROWS = 2000;
  let rows: CommentRow[] = [];
  try {
    // A post that is translated is several `content` rows sharing a
    // translation_group_id; a comment can be attached to any of them
    // (whichever locale the visitor submitted from), so match the whole group.
    const contentIds = await resolveContentGroupIds(db, ctx.siteId, ctx.content);
    const placeholders = contentIds.map(() => "?").join(", ");
    rows = await db.query<CommentRow>(
      `SELECT id, parent_id, author_name, author_url, body, created_at, edited_at
         FROM comments
        WHERE site_id = ? AND status = 'approved' AND content_id IN (${placeholders})
        ORDER BY created_at ASC
        LIMIT ?`,
      [ctx.siteId, ...contentIds, MAX_ROWS],
    );
  } catch (err) {
    // A schema mismatch (migration 0013 not applied yet) or a transient DB
    // error must not make the whole discussion section disappear — still show
    // the heading and form.
    console.error("[justflows] loading approved comments failed:", err);
    rows = [];
  }

  let roots = buildThread(rows);
  if (props.order === "newest") roots = [...roots].reverse();
  const totalPages = Math.max(1, Math.ceil(roots.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageRoots = roots.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  const listHtml = pageRoots.length
    ? `<ol class="jf-comments__list">${pageRoots
        .map((node) => renderNode(node, ctx, settings, state.accepting, 0))
        .join("")}</ol>`
    : `<p class="jf-comments__empty">${esc(ctx.t("comments.empty"))}</p>`;

  const pager =
    totalPages > 1
      ? `<nav class="jf-comments__pager" aria-label="${esc(ctx.t("comments.heading"))}">
          ${clampedPage > 1 ? `<a href="${esc(pageUrl(ctx.basePath, clampedPage - 1))}#jf-comments">«</a>` : ""}
          <span>${clampedPage} / ${totalPages}</span>
          ${
            clampedPage < totalPages
              ? `<a href="${esc(pageUrl(ctx.basePath, clampedPage + 1))}#jf-comments">»</a>`
              : ""
          }
        </nav>`
      : "";

  const count = rows.length;
  const heading = `<h2 class="jf-comments__heading">${esc(props.title || ctx.t("comments.heading"))}${
    count ? ` <span class="jf-comments__count">(${count})</span>` : ""
  }</h2>`;

  const form = state.accepting
    ? formHtml(ctx, settings)
    : `<p class="jf-comments__closed">${esc(ctx.t("comments.closed"))}</p>`;

  const html = `<section class="jf-comments" id="jf-comments">
    ${heading}
    ${bannerHtml(ctx)}
    ${listHtml}
    ${pager}
    ${form}
  </section>`;

  // Let a plugin restyle or fully replace the markup (see the `comments.render`
  // filter). The threaded data is handed along so a handler can render its own.
  return applyCommentsRenderFilter(html, {
    siteId: ctx.siteId,
    contentId: ctx.content.id,
    contentType: ctx.content.type,
    slug: ctx.content.slug ?? null,
    locale: ctx.locale,
    basePath: ctx.basePath,
    props: { title: props.title, order: props.order },
    visible: state.visible,
    accepting: state.accepting,
    comments: pageRoots.map((node) => toPublicComment(node, 0)),
    total: rows.length,
    page: clampedPage,
    totalPages,
    banner: ctx.banner ?? null,
    currentUser: ctx.currentUser
      ? { name: ctx.currentUser.name, email: ctx.currentUser.email }
      : null,
    captchaProvider: settings.captchaProvider,
  });
}

function toPublicComment(node: ThreadNode, depth: number): PublicComment {
  return {
    id: String(node.id),
    parentId: node.parent_id ? String(node.parent_id) : null,
    authorName: String(node.author_name ?? ""),
    authorUrl: typeof node.author_url === "string" ? node.author_url : null,
    bodyHtml: String(node.body ?? ""),
    createdAt: toIsoString(node.created_at),
    editedAt: node.edited_at ? toIsoString(node.edited_at) : null,
    depth,
    replies: node.children.map((child) => toPublicComment(child, depth + 1)),
  };
}

/**
 * Run the rendered block through the `comments.render` filter. Cheap when no
 * plugin listens; a throwing or non-string handler is ignored so the default
 * markup always survives.
 */
async function applyCommentsRenderFilter(
  html: string,
  context: CommentsBlockRenderContext,
): Promise<string> {
  try {
    await ensurePluginRuntime();
    const hooks = getRuntimeHooks();
    if (!hooks.has("comments.render")) return html;
    const out = await hooks.applyFilter("comments.render", html, context, {
      siteId: context.siteId,
      source: "http" as const,
    });
    return typeof out === "string" ? out : html;
  } catch (err) {
    console.error("[justflows] comments.render filter failed:", err);
    return html;
  }
}

// ─── Submission ─────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@<>,;:"'\\()[\]]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,}$/i;

/**
 * Turn a submitted comment into safe stored HTML: blank lines become
 * paragraphs, single newlines become <br>, then sanitizeRichText keeps only a
 * small formatting whitelist (bold, italic, links, lists, quote, code) and
 * discards everything else — scripts and their contents included.
 */
export function sanitizeCommentBody(raw: string): string {
  const html = raw
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return sanitizeRichText(html);
}

/** Visible text of a stored comment body, for length checks and email digests. */
export function commentPlainText(html: string): string {
  return sanitizePlainText(html).replace(/\s+/g, " ").trim();
}

function headerText(value: string, max = 160): string {
  return value
    .replace(/[\r\n\0]/g, " ")
    .trim()
    .slice(0, max);
}

function sameOrigin(
  host: string | undefined,
  origin: string | undefined,
  referer: string | undefined,
): boolean {
  if (!host) return false;
  const candidate = origin || referer;
  if (!candidate) return false;
  try {
    return new URL(candidate).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function returnLocation(
  returnTo: string | undefined,
  referer: string | undefined,
  banner: CommentsBannerState,
): string {
  let path = "/";
  const source = returnTo || referer || "/";
  try {
    const url = new URL(source, "http://localhost");
    path = url.pathname + url.search;
  } catch {
    path = typeof source === "string" && source.startsWith("/") ? source : "/";
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}comment=${banner}#jf-comments`;
}

export interface CommentSubmissionInput {
  body: Record<string, unknown>;
  host?: string;
  origin?: string;
  referer?: string;
  clientIp?: string;
  userAgent?: string;
  session?: { userId: string; siteId: string; email?: string } | null;
}

export interface CommentSubmissionResult {
  status: number;
  location?: string;
  error?: string;
}

export async function acceptCommentSubmission(
  input: CommentSubmissionInput,
): Promise<CommentSubmissionResult> {
  const ip = input.clientIp ?? "unknown";
  const b = input.body;
  const returnTo = typeof b.return_to === "string" ? b.return_to : undefined;
  // A failure past this point always bounces back to the post with a banner —
  // a bare text response at this URL is a dead end with no way back for a
  // visitor whose browser did a full-page form submit (no JS).
  const fail = (status: number, error: string, banner: CommentsBannerState = "error") => ({
    status,
    error,
    location: returnLocation(returnTo, input.referer, banner),
  });

  // Unauthenticated write. Without a ceiling a script fills the table and the
  // moderation queue; the honeypot below only stops the naive bots.
  if (!consumeRateLimit(`comment:ip:${ip}`, 5, 10 * 60 * 1000)) {
    return fail(429, "Too many comments. Please try again later.", "rate_limited");
  }
  // A signed-in account is a stickier identity than an IP (shared NAT, VPNs,
  // mobile carriers) — cap it separately rather than relying on the IP bucket.
  if (
    input.session?.userId &&
    !consumeRateLimit(`comment:user:${input.session.userId}`, 8, 10 * 60 * 1000)
  ) {
    return fail(429, "Too many comments. Please try again later.", "rate_limited");
  }

  if (!sameOrigin(input.host, input.origin, input.referer)) {
    return fail(403, "Bad origin");
  }

  // Honeypot: a filled `website_url` is a bot. Behave like success so it learns
  // nothing, but write nothing.
  if (String(b.website_url ?? "").trim()) {
    return { status: 303, location: returnLocation(returnTo, input.referer, "pending") };
  }

  const db = await getDb();
  const siteId = await getSiteId();
  if (!siteId) return fail(404, "Comments are not available");

  const settings = await getCommentSettings(siteId);

  const contentId = String(b.content_id ?? "").trim();
  if (!contentId) return fail(400, "Missing post");

  // A token is only proof of "this form was rendered for this post" if it's
  // pinned to that post — otherwise one harvested token could be replayed
  // against any content_id for as long as it stays within its max age.
  const rawFormToken = verifyCommentFormToken(b.form_token);
  const formToken =
    rawFormToken && rawFormToken.siteId === siteId && rawFormToken.contentId === contentId
      ? rawFormToken
      : null;
  const formTokenStatus: FormTokenStatus = !formToken
    ? "missing"
    : Date.now() - formToken.issuedAt < settings.minRenderAgeSeconds * 1000
      ? "tooFast"
      : "ok";
  const contentRows = await db.query<{
    id: string;
    type: string;
    slug: string | null;
    status: string;
    published_at: string | null;
    translation_group_id: string | null;
    fields: unknown;
  }>(
    "SELECT id, type, slug, status, published_at, translation_group_id, fields FROM content WHERE id = ? AND site_id = ? LIMIT 1",
    [contentId, siteId],
  );
  const content = contentRows[0];
  if (!content || !contentTypePolicy(content.type).publiclyDiscoverable || content.status !== "published") {
    return fail(404, "Post not found");
  }

  const fields = typeof content.fields === "string" ? safeParse(content.fields) : content.fields;
  const state = commentsStateFor({ fields, publishedAt: content.published_at }, settings);
  if (!state.visible || !state.accepting) {
    return fail(403, "Comments are closed for this post");
  }

  // CAPTCHA, when configured.
  if (settings.captchaProvider !== "none" && settings.captchaSiteKey) {
    const meta = CAPTCHA_META[settings.captchaProvider];
    const token = String(b[meta.field] ?? "").trim();
    const ok = await verifyCaptcha(settings.captchaProvider, settings.captchaSecretKey, token, ip, {
      expectedAction: RECAPTCHA_V3_ACTION,
      scoreThreshold: settings.captchaScoreThreshold,
    });
    if (!ok) return { status: 400, location: returnLocation(returnTo, input.referer, "captcha") };
  }

  // Parent must be an approved comment on the same post, not too deep.
  let parentId: string | null = null;
  const rawParent = String(b.parent_id ?? "").trim();
  if (rawParent) {
    const parentRows = await db.query<{
      id: string;
      parent_id: string | null;
      status: string;
      content_id: string;
    }>(
      "SELECT id, parent_id, status, content_id FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
      [rawParent, siteId],
    );
    const parent = parentRows[0];
    // The thread a visitor replies from lists comments across the whole
    // translation group (see resolveContentGroupIds), so a comment they can
    // see and click "reply" on may live under a sibling locale's content id.
    const contentGroupIds = await resolveContentGroupIds(db, siteId, {
      id: content.id,
      type: content.type,
      slug: content.slug ?? undefined,
      translationGroupId: content.translation_group_id,
      publishedAt: content.published_at,
      fields,
    });
    if (
      !parent ||
      parent.status !== "approved" ||
      !contentGroupIds.includes(parent.content_id)
    ) {
      return fail(400, "Cannot reply to that comment");
    }
    if ((await commentDepth(db, siteId, parent.id)) + 1 >= settings.threadMaxDepth + 4) {
      return fail(400, "Reply nesting is too deep");
    }
    parentId = parent.id;
  }

  // Identity: a signed-in user's name/email is authoritative; otherwise take
  // what was typed.
  let authorName = String(b.author_name ?? "")
    .trim()
    .slice(0, 120);
  let authorEmail = String(b.author_email ?? "")
    .trim()
    .slice(0, 320);
  let userId: string | null = null;
  if (input.session?.userId) {
    const userRows = await db.query<{ display_name: string; username: string; email: string }>(
      "SELECT display_name, username, email FROM users WHERE id = ? AND site_id = ? LIMIT 1",
      [input.session.userId, siteId],
    );
    const u = userRows[0];
    if (u) {
      authorName = (u.display_name || u.username).slice(0, 120);
      authorEmail = u.email;
      userId = input.session.userId;
    }
  }

  if (!authorName) return fail(400, "Name is required");
  if (authorEmail && !EMAIL_RE.test(authorEmail)) return fail(400, "Email looks invalid");

  let authorUrl = "";
  if (settings.allowUrls) {
    const rawUrl = String(b.author_url ?? "")
      .trim()
      .slice(0, 500);
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === "http:" || parsed.protocol === "https:")
          authorUrl = parsed.toString();
      } catch {
        authorUrl = "";
      }
    }
  }

  const rawBody = String(b.body ?? "").trim();
  if (rawBody.length < 2) return fail(400, "Comment is empty");
  if (rawBody.length > settings.maxLength) return fail(400, "Comment is too long");
  const cleanBody = sanitizeCommentBody(rawBody);
  if (!commentPlainText(cleanBody)) {
    return fail(400, "Comment is empty");
  }

  const wantsNotify =
    (b.notify === "1" || b.notify === "on" || b.notify === true) && Boolean(authorEmail);

  const decision = await decide({
    siteId,
    contentId,
    ip,
    userAgent: input.userAgent ?? "",
    authorName,
    authorEmail,
    authorUrl,
    bodyHtml: cleanBody,
    plainText: commentPlainText(cleanBody),
    userId,
    isAuthenticated: Boolean(userId),
    formToken: formTokenStatus,
    settings,
  });
  const status = decision.status;

  const id = randomUUID();
  const nowIso = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
  await db.run(
    `INSERT INTO comments
       (id, site_id, content_id, parent_id, author_name, author_email, author_url, body, status, user_id, ip_address, notify, unsubscribe_token, spam_score, spam_reasons, held_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      siteId,
      contentId,
      parentId,
      authorName,
      authorEmail || null,
      authorUrl || null,
      cleanBody,
      status,
      userId,
      ip.slice(0, 64),
      wantsNotify,
      wantsNotify ? randomUUID().replace(/-/g, "") : null,
      decision.score,
      JSON.stringify(decision.reasons),
      decision.heldReason,
      nowIso,
      nowIso,
    ],
  );

  if (status === "pending" && settings.notifyModerator) {
    void notifyModerator(siteId, authorName, cleanBody).catch(() => undefined);
  }
  if (status === "approved") {
    // A visible new comment invalidates the cached post page for everyone else.
    void import("../cache/public-cache.js")
      .then(({ invalidatePublicPages }) => invalidatePublicPages())
      .catch(() => undefined);
    if (parentId) void notifyParentAuthor(siteId, parentId, id).catch(() => undefined);
  }

  return {
    status: 303,
    location: returnLocation(returnTo, input.referer, status === "approved" ? "posted" : "pending"),
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function commentDepth(
  db: Awaited<ReturnType<typeof getDb>>,
  siteId: string,
  commentId: string,
): Promise<number> {
  let depth = 0;
  let current: string | null = commentId;
  // Bounded walk up the parent chain.
  for (let i = 0; i < 50 && current; i++) {
    const rows: Array<{ parent_id: string | null }> = await db.query<{ parent_id: string | null }>(
      "SELECT parent_id FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
      [current, siteId],
    );
    current = rows[0]?.parent_id ?? null;
    if (current) depth++;
  }
  return depth;
}

async function notifyModerator(siteId: string, author: string, body: string): Promise<void> {
  const general = await getGeneralSettings(siteId);
  if (!general.adminEmail) return;
  const { sendMail } = await import("../email/mail.js");
  const text = commentPlainText(body).slice(0, 2000);
  const appUrl = process.env.APP_URL ?? "";
  const { getAdminPathConfig } = await import("../admin/admin-path.js");
  const adminPath = (await getAdminPathConfig()).path;
  await sendMail({
    to: general.adminEmail,
    subject: `New comment awaiting moderation from ${headerText(author, 80)}`,
    text: `A new comment is waiting in the moderation queue.\n\nFrom: ${headerText(
      author,
      80,
    )}\n\n${text}\n\n${appUrl ? `${appUrl.replace(/\/$/, "")}${adminPath}/comments` : "Admin → Comments"}`,
  });
}

async function notifyParentAuthor(
  siteId: string,
  parentId: string,
  newCommentId: string,
): Promise<void> {
  const db = await getDb();
  const parentRows = await db.query<{
    author_email: string | null;
    notify: unknown;
    unsubscribe_token: string | null;
  }>(
    "SELECT author_email, notify, unsubscribe_token FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
    [parentId, siteId],
  );
  const parent = parentRows[0];
  if (!parent?.author_email || !truthy(parent.notify)) return;

  const childRows = await db.query<{ author_name: string; body: string; content_id: string }>(
    "SELECT author_name, body, content_id FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
    [newCommentId, siteId],
  );
  const child = childRows[0];
  if (!child) return;

  const slugRows = await db.query<{ slug: string; locale: string }>(
    "SELECT slug, locale FROM content WHERE id = ? LIMIT 1",
    [child.content_id],
  );
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const postUrl = slugRows[0] ? `${appUrl}/${slugRows[0].slug}#jf-comment-${newCommentId}` : appUrl;
  const unsubUrl =
    appUrl && parent.unsubscribe_token
      ? `${appUrl}/justflows-comments/unsubscribe?token=${encodeURIComponent(parent.unsubscribe_token)}`
      : "";

  const { sendMail } = await import("../email/mail.js");
  const text = commentPlainText(child.body).slice(0, 1500);
  await sendMail({
    to: parent.author_email,
    subject: `${headerText(child.author_name, 80)} replied to your comment`,
    text: `${headerText(child.author_name, 80)} replied to your comment:\n\n${text}\n\n${postUrl}${
      unsubUrl ? `\n\nStop these emails: ${unsubUrl}` : ""
    }`,
  });
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

/**
 * Called from the moderation route when a pending comment is approved, so a
 * reply that was held for moderation still notifies the parent author.
 */
export async function notifyOnApproval(siteId: string, commentIds: string[]): Promise<void> {
  const db = await getDb();
  for (const id of commentIds) {
    const rows = await db.query<{ parent_id: string | null; status: string }>(
      "SELECT parent_id, status FROM comments WHERE id = ? AND site_id = ? LIMIT 1",
      [id, siteId],
    );
    const row = rows[0];
    if (row?.status === "approved" && row.parent_id) {
      await notifyParentAuthor(siteId, row.parent_id, id).catch(() => undefined);
    }
  }
}

/** Unsubscribe a commenter from reply notifications. Returns rows touched. */
export async function clearCommentNotify(token: string): Promise<boolean> {
  const clean = token.trim();
  if (!clean || clean.length > 64) return false;
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    "SELECT id FROM comments WHERE unsubscribe_token = ? LIMIT 1",
    [clean],
  );
  if (!rows[0]) return false;
  await db.run("UPDATE comments SET notify = ? WHERE unsubscribe_token = ?", [false, clean]);
  return true;
}
