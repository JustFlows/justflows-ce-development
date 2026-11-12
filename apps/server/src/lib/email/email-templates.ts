// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { sanitizeHtmlBlock, sanitizePlainText } from "@justflows/blocks";
import { getDb } from "../database/db.js";
import { getDefaultLocale } from "../i18n/languages-db.js";
import { getSiteId } from "../settings/site-settings.js";
import { isInstallationRootRequest } from "../tenancy/access.js";

/** `YYYY-MM-DD HH:MM:SS` — the shape MySQL DATETIME accepts and SQLite sorts correctly. */
function now(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export type EmailVariableKind = "text" | "url";

export interface EmailVariableDefinition {
  key: string;
  label: string;
  description: string;
  kind: EmailVariableKind;
  example: string;
  required?: boolean;
}

export interface EmailTemplateDefinition {
  key: string;
  owner: string;
  label: string;
  description: string;
  purpose: "account" | "security" | "administrative";
  recipient: "user" | "administrator";
  disableSafe: boolean;
  /** Sent only by the installation's root site, so other sites do not list it. */
  platformOnly?: boolean;
  variables: EmailVariableDefinition[];
  defaults: { subject: string; preheader: string; html: string; text: string };
  localizedDefaults?: Record<string, { subject: string; preheader: string; html: string; text: string }>;
}

const commonVariables: EmailVariableDefinition[] = [
  { key: "site_name", label: "Site name", description: "The configured site name.", kind: "text", example: "Acme Studio", required: true },
  { key: "display_name", label: "Display name", description: "The recipient's public display name.", kind: "text", example: "Alex", required: true },
];

const actionVariables: EmailVariableDefinition[] = [
  ...commonVariables,
  { key: "action_url", label: "Action URL", description: "A server-generated, time-limited destination.", kind: "url", example: "https://example.com/account/action", required: true },
  { key: "expiration", label: "Expiration", description: "How long the action link remains valid.", kind: "text", example: "60 minutes" },
];

const securityVariables: EmailVariableDefinition[] = [
  ...commonVariables,
  { key: "support_email", label: "Support email", description: "The configured administration contact.", kind: "text", example: "support@example.com" },
];

function template(input: Omit<EmailTemplateDefinition, "owner">): EmailTemplateDefinition {
  return { owner: "core", ...input };
}

const CORE_TEMPLATES: EmailTemplateDefinition[] = [
  template({ key: "core.account-created", label: "Account created", description: "Welcomes a new account and links to sign in.", purpose: "account", recipient: "user", disableSafe: false, variables: [...actionVariables, { key: "username", label: "Username", description: "The account username.", kind: "text", example: "alex" }], defaults: { subject: "Your account at {{site_name}} is ready", preheader: "Your account has been created.", html: "<h1>Welcome, {{display_name}}</h1><p>Your account at <strong>{{site_name}}</strong> is ready.</p><p><a href=\"{{action_url}}\">Sign in to your account</a></p><p>Username: <strong>{{username}}</strong></p>", text: "Welcome, {{display_name}}\n\nYour account at {{site_name}} is ready.\n\nSign in: {{action_url}}\nUsername: {{username}}" } }),
  template({ key: "core.password-reset", label: "Password reset", description: "Delivers the single-use password reset link.", purpose: "security", recipient: "user", disableSafe: false, variables: actionVariables, defaults: { subject: "Reset your {{site_name}} password", preheader: "Use this link to choose a new password.", html: "<h1>Reset your password</h1><p>Hello {{display_name}},</p><p>We received a request to reset your {{site_name}} password.</p><p><a href=\"{{action_url}}\">Choose a new password</a></p><p>{{#if expiration}}This link expires in {{expiration}}.{{/if}}</p><p>If you did not request this, you can ignore this email.</p>", text: "Hello {{display_name}},\n\nReset your {{site_name}} password: {{action_url}}\n\nThis link expires in {{expiration}}. If you did not request this, ignore this email." } }),
  template({ key: "core.password-changed", label: "Password changed", description: "Security notice after a password change.", purpose: "security", recipient: "user", disableSafe: false, variables: securityVariables, defaults: { subject: "Your {{site_name}} password was changed", preheader: "A security change was made to your account.", html: "<h1>Password changed</h1><p>Hello {{display_name}},</p><p>The password on your {{site_name}} account was just changed.</p><p>If this was not you, contact {{support_email}} immediately. All other sessions have been signed out.</p>", text: "Hello {{display_name}},\n\nThe password on your {{site_name}} account was just changed.\n\nIf this was not you, contact {{support_email}} immediately. All other sessions have been signed out." } }),
  template({ key: "core.email-verification", label: "Email verification", description: "Confirms ownership of a new email address.", purpose: "account", recipient: "user", disableSafe: false, variables: actionVariables, defaults: { subject: "Verify your email for {{site_name}}", preheader: "Confirm this email address.", html: "<h1>Verify your email</h1><p>Hello {{display_name}},</p><p><a href=\"{{action_url}}\">Verify this email address</a></p><p>{{#if expiration}}This link expires in {{expiration}}.{{/if}}</p>", text: "Hello {{display_name}},\n\nVerify your email for {{site_name}}: {{action_url}}\n\nThis link expires in {{expiration}}." } }),
  template({ key: "core.two-factor-enabled", label: "Two-factor enabled", description: "Security notice after two-factor authentication is enabled.", purpose: "security", recipient: "user", disableSafe: false, variables: securityVariables, defaults: { subject: "Two-factor authentication is on", preheader: "Your account security changed.", html: "<h1>Two-factor authentication is on</h1><p>Hello {{display_name}},</p><p>Two-factor authentication was enabled for your {{site_name}} account.</p><p>If this was not you, contact {{support_email}} immediately.</p>", text: "Hello {{display_name}},\n\nTwo-factor authentication was enabled for your {{site_name}} account. If this was not you, contact {{support_email}} immediately." } }),
  template({ key: "core.two-factor-disabled", label: "Two-factor disabled", description: "Security notice after two-factor authentication is disabled.", purpose: "security", recipient: "user", disableSafe: false, variables: securityVariables, defaults: { subject: "Two-factor authentication is off", preheader: "Your account security changed.", html: "<h1>Two-factor authentication is off</h1><p>Hello {{display_name}},</p><p>Two-factor authentication was disabled for your {{site_name}} account.</p><p>If this was not you, contact {{support_email}} immediately.</p>", text: "Hello {{display_name}},\n\nTwo-factor authentication was disabled for your {{site_name}} account. If this was not you, contact {{support_email}} immediately." } }),
  template({ key: "core.security-alert", label: "Security alert", description: "General high-priority account security warning.", purpose: "security", recipient: "user", disableSafe: false, variables: [...securityVariables, { key: "alert", label: "Alert", description: "A safe description generated by the server.", kind: "text", example: "A new sign-in was detected.", required: true }, { key: "request_ip", label: "Request IP", description: "A coarse request IP summary, when available.", kind: "text", example: "192.0.2.x" }], defaults: { subject: "Security alert for {{site_name}}", preheader: "Please review recent account activity.", html: "<h1>Security alert</h1><p>Hello {{display_name}},</p><p>{{alert}}</p><p>{{#if request_ip}}Request IP: {{request_ip}}{{/if}}</p><p>If this was not you, contact {{support_email}} immediately.</p>", text: "Hello {{display_name}},\n\n{{alert}}\n{{#if request_ip}}Request IP: {{request_ip}}{{/if}}\n\nIf this was not you, contact {{support_email}} immediately." } }),
  template({ key: "core.admin-notification", label: "Administrative notification", description: "Notifies the site administrator about system activity.", purpose: "administrative", recipient: "administrator", disableSafe: true, variables: [{ key: "site_name", label: "Site name", description: "The configured site name.", kind: "text", example: "Acme Studio", required: true }, { key: "title", label: "Title", description: "A server-generated event title.", kind: "text", example: "New user registration", required: true }, { key: "message", label: "Message", description: "A server-generated event summary.", kind: "text", example: "A new user registered.", required: true }], defaults: { subject: "[{{site_name}}] {{title}}", preheader: "{{title}}", html: "<h1>{{title}}</h1><p>{{message}}</p>", text: "{{title}}\n\n{{message}}" } }),
  template({ key: "core.site-created", label: "Site created", description: "Sends a new site's owner the site address, the admin sign-in address and the email to sign in with, when a workspace is created.", purpose: "account", recipient: "user", disableSafe: false, platformOnly: true, variables: [...securityVariables, { key: "new_site_name", label: "New site name", description: "The name of the site that was created.", kind: "text", example: "Acme Studio", required: true }, { key: "site_url", label: "Site URL", description: "The new site's public address.", kind: "url", example: "https://acme.example.com", required: true }, { key: "admin_url", label: "Admin sign-in URL", description: "The new site's admin sign-in address under its admin path.", kind: "url", example: "https://acme.example.com/admin/login", required: true }, { key: "login_email", label: "Sign-in email", description: "The email address the owner signs in with.", kind: "text", example: "owner@example.com", required: true }], defaults: { subject: "Your site {{new_site_name}} is ready", preheader: "Your new site and where to sign in.", html: "<h1>Your site is ready</h1><p>Hello {{display_name}},</p><p>Your site <strong>{{new_site_name}}</strong> has been created. Keep this email: it has everything you need to get back to it.</p><p>Site: <a href=\"{{site_url}}\">{{site_url}}</a></p><p>Admin sign-in: <a href=\"{{admin_url}}\">{{admin_url}}</a></p><p>Sign-in email: <strong>{{login_email}}</strong></p><p>Sign in with this email address and your password. If you forget your password, use the reset link on the sign-in page.</p><p>{{#if support_email}}Questions? Contact {{support_email}}.{{/if}}</p>", text: "Hello {{display_name}},\n\nYour site {{new_site_name}} has been created. Keep this email: it has everything you need to get back to it.\n\nSite: {{site_url}}\nAdmin sign-in: {{admin_url}}\nSign-in email: {{login_email}}\n\nSign in with this email address and your password. If you forget your password, use the reset link on the sign-in page.\n\n{{#if support_email}}Questions? Contact {{support_email}}.{{/if}}" } }),
  template({ key: "core.owned-sites", label: "Your sites", description: "Lists the sites an owner has, with each site's admin sign-in address, when they ask for them by email.", purpose: "account", recipient: "user", disableSafe: false, platformOnly: true, variables: [...commonVariables, { key: "site_list", label: "Site list", description: "Per site: its name, its address, and its admin sign-in address. Generated by the server.", kind: "text", example: "Acme Studio\nSite: https://acme.example.com\nAdmin: https://acme.example.com/admin/login", required: true }], defaults: { subject: "Your sites", preheader: "The sites that belong to this email address.", html: "<h1>Your sites</h1><p>Hello {{display_name}},</p><p>You asked which sites belong to this email address. Here they are, with the address where you sign in to each site's admin:</p><p>{{site_list}}</p><p>Keep this email private. Your admin address is only for you.</p><p>If you did not ask for this, you can ignore this email.</p>", text: "Hello {{display_name}},\n\nYou asked which sites belong to this email address. Here they are, with the address where you sign in to each site's admin:\n\n{{site_list}}\n\nKeep this email private. Your admin address is only for you.\n\nIf you did not ask for this, you can ignore this email." } }),
];

const definitions = new Map(CORE_TEMPLATES.map((item) => [item.key, item]));

export function registerEmailTemplate(definition: EmailTemplateDefinition): () => void {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(definition.key)) throw new Error("Invalid email template key");
  if (definitions.has(definition.key)) throw new Error(`Email template ${definition.key} is already registered`);
  definitions.set(definition.key, definition);
  return () => definitions.delete(definition.key);
}

export function listEmailTemplateDefinitions(): EmailTemplateDefinition[] {
  return [...definitions.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function defaultEmailTemplateContent(
  definition: EmailTemplateDefinition,
  locale: string,
): EmailTemplateDefinition["defaults"] {
  return definition.localizedDefaults?.[locale] ?? definition.defaults;
}

export interface EmailDesign {
  logoUrl: string;
  darkLogoUrl: string;
  accentColor: string;
  pageBackground: string;
  contentBackground: string;
  textColor: string;
  fontFamily: string;
  contentWidth: number;
  radius: number;
  alignment: "left" | "center";
  companyName: string;
  address: string;
  supportContact: string;
  footerText: string;
}

export const DEFAULT_EMAIL_DESIGN: EmailDesign = { logoUrl: "", darkLogoUrl: "", accentColor: "#2563eb", pageBackground: "#f3f4f6", contentBackground: "#ffffff", textColor: "#172033", fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", contentWidth: 600, radius: 12, alignment: "left", companyName: "", address: "", supportContact: "", footerText: "You received this system notification because you have an account or administrative role." };

type TemplateRow = { id: string; template_key: string; owner: string; locale: string; version: number; status: string; enabled: boolean | number; sender_name: string | null; reply_to_policy: string; subject: string; preheader: string; html_content: string; text_content: string; created_at: string; published_at: string | null };

export async function getEmailDesign(siteId: string, status: "draft" | "published" = "draft"): Promise<{ design: EmailDesign; version: number; status: string }> {
  const rows = await (await getDb()).query<{ design: string; version: number; status: string }>("SELECT design, version, status FROM email_design_versions WHERE site_id = ? AND status = ? ORDER BY version DESC LIMIT 1", [siteId, status]);
  const fallback = status === "draft" ? await (await getDb()).query<{ design: string; version: number; status: string }>("SELECT design, version, status FROM email_design_versions WHERE site_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", [siteId]) : [];
  const row = rows[0] ?? fallback[0];
  if (!row) return { design: DEFAULT_EMAIL_DESIGN, version: 0, status: "default" };
  try { return { design: { ...DEFAULT_EMAIL_DESIGN, ...JSON.parse(row.design) }, version: Number(row.version), status: row.status }; } catch { return { design: DEFAULT_EMAIL_DESIGN, version: 0, status: "default" }; }
}

export async function saveEmailDesign(siteId: string, design: EmailDesign, userId: string, publish: boolean): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ version: number }>("SELECT version FROM email_design_versions WHERE site_id = ? ORDER BY version DESC LIMIT 1", [siteId]);
  const version = Number(rows[0]?.version ?? 0) + 1;
  await db.run("UPDATE email_design_versions SET status = 'archived' WHERE site_id = ? AND status = ?", [siteId, publish ? "published" : "draft"]);
  if (publish) await db.run("UPDATE email_design_versions SET status = 'archived' WHERE site_id = ? AND status = 'draft'", [siteId]);
  const timestamp = now();
  await db.run("INSERT INTO email_design_versions (id, site_id, version, status, design, created_by, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), siteId, version, publish ? "published" : "draft", JSON.stringify(design), userId, timestamp, publish ? timestamp : null]);
  return version;
}

export async function getTemplateRow(siteId: string, key: string, locale: string, status: "draft" | "published" = "draft"): Promise<TemplateRow | null> {
  const db = await getDb();
  const exact = await db.query<TemplateRow>("SELECT * FROM email_template_versions WHERE site_id = ? AND template_key = ? AND locale = ? AND status = ? ORDER BY version DESC LIMIT 1", [siteId, key, locale, status]);
  if (exact[0]) return exact[0];
  if (status === "draft") {
    const published = await db.query<TemplateRow>("SELECT * FROM email_template_versions WHERE site_id = ? AND template_key = ? AND locale = ? AND status = 'published' ORDER BY version DESC LIMIT 1", [siteId, key, locale]);
    if (published[0]) return published[0];
  }
  return null;
}

export async function saveEmailTemplate(siteId: string, key: string, locale: string, input: { enabled: boolean; senderName: string; replyToPolicy: "global" | "none"; subject: string; preheader: string; html: string; text: string }, userId: string, publish: boolean): Promise<number> {
  const definition = definitions.get(key);
  if (!definition) throw new Error("Unknown email template");
  const db = await getDb();
  const rows = await db.query<{ version: number }>("SELECT version FROM email_template_versions WHERE site_id = ? AND template_key = ? AND locale = ? ORDER BY version DESC LIMIT 1", [siteId, key, locale]);
  const version = Number(rows[0]?.version ?? 0) + 1;
  await db.run("UPDATE email_template_versions SET status = 'archived' WHERE site_id = ? AND template_key = ? AND locale = ? AND status = ?", [siteId, key, locale, publish ? "published" : "draft"]);
  if (publish) await db.run("UPDATE email_template_versions SET status = 'archived' WHERE site_id = ? AND template_key = ? AND locale = ? AND status = 'draft'", [siteId, key, locale]);
  const timestamp = now();
  await db.run("INSERT INTO email_template_versions (id, site_id, template_key, owner, locale, version, status, enabled, sender_name, reply_to_policy, subject, preheader, html_content, text_content, created_by, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), siteId, key, definition.owner, locale, version, publish ? "published" : "draft", input.enabled, input.senderName || null, input.replyToPolicy, input.subject, input.preheader, sanitizeHtmlBlock(input.html), sanitizePlainText(input.text), userId, timestamp, publish ? timestamp : null]);
  return version;
}

function htmlEscape(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function safeUrl(value: string): string { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? htmlEscape(url.toString()) : "#"; } catch { return value.startsWith("/") ? htmlEscape(value) : "#"; } }

function interpolate(source: string, definition: EmailTemplateDefinition, values: Record<string, string>, html: boolean): string {
  const allowed = new Map(definition.variables.map((variable) => [variable.key, variable]));
  let rendered = source.replace(/{{#if\s+([a-z0-9_]+)}}([\s\S]*?){{\/if}}/gi, (_all, key: string, body: string) => allowed.has(key) && values[key] ? body : "");
  rendered = rendered.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (_all, key: string) => {
    const variable = allowed.get(key);
    if (!variable) return "";
    const value = String(values[key] ?? "");
    /** Multi-line text values keep their line breaks in HTML. */
    return html ? (variable.kind === "url" ? safeUrl(value) : htmlEscape(value).replace(/\r?\n/g, "<br>")) : value;
  });
  return rendered;
}

function validateTemplate(definition: EmailTemplateDefinition, source: { subject: string; html: string; text: string }, values: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const variable of definition.variables) if (variable.required && !values[variable.key]) errors.push(`Missing required variable: ${variable.key}`);
  const known = new Set(definition.variables.map((item) => item.key));
  for (const match of `${source.subject}\n${source.html}\n${source.text}`.matchAll(/{{(?:#if\s+|\/if\s*)?([a-z0-9_]+)?\s*}}/gi)) if (match[1] && !known.has(match[1])) errors.push(`Unknown variable: ${match[1]}`);
  return [...new Set(errors)];
}

function wrapHtml(content: string, preheader: string, design: EmailDesign): string {
  const logo = design.logoUrl ? `<img src="${safeUrl(design.logoUrl)}" alt="${htmlEscape(design.companyName || "Site logo")}" style="max-width:180px;max-height:56px">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title></title></head><body style="margin:0;background:${design.pageBackground};color:${design.textColor};font-family:${design.fontFamily}"><div style="display:none;max-height:0;overflow:hidden">${htmlEscape(preheader)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${design.pageBackground}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:${design.contentWidth}px;background:${design.contentBackground};border-radius:${design.radius}px"><tr><td style="padding:32px;text-align:${design.alignment}">${logo}<div style="line-height:1.6">${content}</div><hr style="border:0;border-top:1px solid #d8dce5;margin:28px 0"><div style="font-size:12px;line-height:1.5;color:#667085">${htmlEscape(design.footerText)}${design.address ? `<br>${htmlEscape(design.address)}` : ""}</div></td></tr></table></td></tr></table></body></html>`;
}

export async function renderEmailTemplate(input: { siteId?: string; key: string; locale?: string; values: Record<string, string>; mode?: "draft" | "published" }): Promise<{ subject: string; preheader: string; html: string; text: string; version: number; locale: string; fallback: boolean; enabled: boolean; senderName: string; replyToPolicy: string; errors: string[] }> {
  const definition = definitions.get(input.key);
  if (!definition) throw new Error("Unknown email template");
  const siteId = input.siteId ?? await getSiteId();
  if (!siteId) throw new Error("No site found");
  const locale = input.locale || await getDefaultLocale();
  const mode = input.mode ?? "published";
  const row = await getTemplateRow(siteId, input.key, locale, mode);
  const defaultLocale = await getDefaultLocale();
  const fallbackRow = row ?? (locale !== defaultLocale ? await getTemplateRow(siteId, input.key, defaultLocale, mode) : null);
  const builtIn = defaultEmailTemplateContent(definition, locale);
  const source = fallbackRow ? { subject: fallbackRow.subject, preheader: fallbackRow.preheader, html: fallbackRow.html_content, text: fallbackRow.text_content } : builtIn;
  const design = (await getEmailDesign(siteId, mode)).design;
  const rendered = renderEmailSource({ key: input.key, values: input.values, source, design });
  const errors = rendered.errors;
  const fallback = !fallbackRow || errors.length > 0;
  const safeSource = errors.length ? builtIn : source;
  const output = errors.length ? renderEmailSource({ key: input.key, values: input.values, source: safeSource, design }) : rendered;
  return { ...output, version: fallbackRow?.version ?? 0, locale: fallbackRow?.locale ?? defaultLocale, fallback, enabled: fallbackRow ? Boolean(fallbackRow.enabled) : true, senderName: fallbackRow?.sender_name ?? "", replyToPolicy: fallbackRow?.reply_to_policy ?? "global", errors };
}

export function renderEmailSource(input: { key: string; values: Record<string, string>; source: { subject: string; preheader: string; html: string; text: string }; design: EmailDesign }): { subject: string; preheader: string; html: string; text: string; errors: string[] } {
  const definition = definitions.get(input.key);
  if (!definition) throw new Error("Unknown email template");
  const errors = validateTemplate(definition, input.source, input.values);
  const htmlContent = interpolate(sanitizeHtmlBlock(input.source.html), definition, input.values, true);
  const preheader = interpolate(input.source.preheader, definition, input.values, false);
  return { subject: interpolate(input.source.subject.replace(/[\r\n]/g, " "), definition, input.values, false), preheader, html: wrapHtml(htmlContent, preheader, input.design), text: interpolate(sanitizePlainText(input.source.text), definition, input.values, false), errors };
}

export function previewValues(definition: EmailTemplateDefinition): Record<string, string> { return Object.fromEntries(definition.variables.map((item) => [item.key, item.example])); }

export async function listManagedEmailTemplates(siteId: string, locale: string) {
  const root = isInstallationRootRequest();
  return Promise.all(listEmailTemplateDefinitions().filter((definition) => root || !definition.platformOnly).map(async (definition) => { const row = await getTemplateRow(siteId, definition.key, locale); const builtIn = defaultEmailTemplateContent(definition, locale); return { ...definition, current: row ? { locale: row.locale, version: Number(row.version), status: row.status, enabled: Boolean(row.enabled), senderName: row.sender_name ?? "", replyToPolicy: row.reply_to_policy, subject: row.subject, preheader: row.preheader, html: row.html_content, text: row.text_content, createdAt: row.created_at, publishedAt: row.published_at } : { locale, version: 0, status: "default", enabled: true, senderName: "", replyToPolicy: "global", subject: builtIn.subject, preheader: builtIn.preheader, html: builtIn.html, text: builtIn.text, createdAt: null, publishedAt: null } }; }));
}
