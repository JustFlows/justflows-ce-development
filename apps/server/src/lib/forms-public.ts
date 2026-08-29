// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { getPlugin } from "./plugins-db.js";
import { createPluginDataApi } from "./plugin-data.js";
import { getSiteId } from "./themes-db.js";
import { getRuntimeBlockRegistry } from "./runtime-blocks.js";
import { getPluginSetting } from "./plugin-kv.js";
import { getGeneralSettings } from "./general-settings.js";
import { consumeRateLimit } from "./rate-limit.js";

export const FORMS_PLUGIN_ID = "justflows.forms";
export const FORMS_BLOCK_TYPE = "justflows.forms.form";

export const FORM_FIELD_TYPES = ["text", "email", "textarea", "tel", "select", "checkbox"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  id: string;
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options?: string;
}

export interface FormDefinition {
  name: string;
  title: string;
  submitLabel: string;
  successMessage: string;
  fields: FormField[];
}

export interface FormRecord {
  id: string;
  data: FormDefinition;
}

export interface FormSubmission {
  formId: string;
  formName: string;
  values: Record<string, string>;
  createdAt: string;
}

const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const RESERVED_NAMES = new Set(["formId", "_gotcha", "submitted"]);

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function isFormsPluginEnabled(siteId?: string): Promise<boolean> {
  const id = siteId ?? (await getSiteId());
  if (!id) return false;
  const plugin = await getPlugin(id, FORMS_PLUGIN_ID);
  return plugin?.status === "active";
}

function store(siteId: string) {
  return createPluginDataApi(FORMS_PLUGIN_ID, siteId);
}

function sanitizeField(raw: unknown): FormField | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const name = String(row.name ?? "").trim();
  if (!FIELD_NAME_RE.test(name) || RESERVED_NAMES.has(name)) return null;
  const type = FORM_FIELD_TYPES.includes(row.type as FormFieldType) ? (row.type as FormFieldType) : "text";
  return {
    id: String(row.id ?? randomUUID()),
    name,
    label: String(row.label ?? name).slice(0, 120) || name,
    type,
    required: Boolean(row.required),
    options: type === "select" ? String(row.options ?? "") : undefined,
  };
}

export function sanitizeForm(raw: unknown): FormDefinition {
  const row = (raw ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(row.fields)
    ? row.fields.map(sanitizeField).filter((field): field is FormField => Boolean(field))
    : [];
  return {
    name: String(row.name ?? "Form").slice(0, 80) || "Form",
    title: String(row.title ?? "").slice(0, 120),
    submitLabel: String(row.submitLabel ?? "Send").slice(0, 60) || "Send",
    successMessage: String(row.successMessage ?? "Thanks, we received your message.").slice(0, 300),
    fields,
  };
}

function defaultContactForm(): FormDefinition {
  return {
    name: "Contact",
    title: "Contact us",
    submitLabel: "Send",
    successMessage: "Thanks, we received your message.",
    fields: [
      { id: "name", name: "name", label: "Name", type: "text", required: true },
      { id: "email", name: "email", label: "Email", type: "email", required: true },
      { id: "message", name: "message", label: "Message", type: "textarea", required: true },
    ],
  };
}

export async function ensureDefaultForm(siteId: string): Promise<void> {
  const api = store(siteId);
  const existing = await api.list<FormDefinition>("forms");
  if (existing.length > 0) return;
  await api.put("forms", "contact", defaultContactForm());
}

export async function listForms(siteId: string): Promise<FormRecord[]> {
  await ensureDefaultForm(siteId);
  const rows = await store(siteId).list<FormDefinition>("forms");
  return rows.map((row) => ({ id: row.id, data: sanitizeForm(row.data) }));
}

export async function getForm(siteId: string, formId: string): Promise<FormRecord | null> {
  await ensureDefaultForm(siteId);
  const row = await store(siteId).get<FormDefinition>("forms", formId);
  if (!row) return null;
  return { id: row.id, data: sanitizeForm(row.data) };
}

export async function saveForm(siteId: string, formId: string | undefined, raw: unknown): Promise<FormRecord> {
  const data = sanitizeForm(raw);
  let id = formId?.trim();
  if (id && !/^[a-z0-9-]{1,40}$/i.test(id)) id = undefined;
  if (!id) {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    id = slug || randomUUID();
    if (await store(siteId).get("forms", id)) id = `${id}-${randomUUID().slice(0, 8)}`;
  }
  id = id.toLowerCase();
  await store(siteId).put("forms", id, data);
  return { id, data };
}

export async function deleteForm(siteId: string, formId: string): Promise<void> {
  await store(siteId).delete("forms", formId);
}

export async function listSubmissions(siteId: string, formId?: string): Promise<Array<{ id: string; data: FormSubmission }>> {
  const rows = await store(siteId).list<FormSubmission>("submissions");
  const items = rows.map((row) => ({ id: row.id, data: row.data }));
  if (!formId) return items.sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt));
  return items
    .filter((row) => row.data.formId === formId)
    .sort((a, b) => b.data.createdAt.localeCompare(a.data.createdAt));
}

export async function deleteSubmission(siteId: string, id: string): Promise<void> {
  await store(siteId).delete("submissions", id);
}

/**
 * The block registry is a process-wide singleton, so a type registered while
 * the plugin was active would otherwise outlive deactivation — still listed in
 * the builder's catalog and still renderable via the generic block path.
 */
export function unregisterFormsBlock(): void {
  getRuntimeBlockRegistry().unregister(FORMS_BLOCK_TYPE);
}

export function registerFormsBlock(): void {
  const registry = getRuntimeBlockRegistry();
  if (registry.get(FORMS_BLOCK_TYPE)) return;
  registry.register({
    type: FORMS_BLOCK_TYPE,
    version: 1,
    title: "Form",
    description: "A form built under Extensions → Forms.",
    icon: "✉",
    category: "content",
    schema: {
      formId: { type: "text", default: "contact" },
    },
    validateProps: (raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return { formId: String(row.formId ?? "contact") };
    },
    render: (props) => `<div class="jf-form" data-jf-form="${esc(String((props as { formId?: string }).formId ?? ""))}"></div>`,
  });
}

function inputHtml(field: FormField): string {
  const name = esc(field.name);
  const required = field.required ? " required" : "";
  if (field.type === "textarea") {
    return `<textarea id="jf-form-${name}" name="${name}" rows="4"${required}></textarea>`;
  }
  if (field.type === "select") {
    const options = String(field.options ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const opts = options.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join("");
    return `<select id="jf-form-${name}" name="${name}"${required}><option value=""></option>${opts}</select>`;
  }
  if (field.type === "checkbox") {
    return `<input id="jf-form-${name}" type="checkbox" name="${name}" value="1"${required}>`;
  }
  const inputType = field.type === "email" || field.type === "tel" ? field.type : "text";
  return `<input id="jf-form-${name}" type="${inputType}" name="${name}"${required}>`;
}

export function renderFormHtml(form: FormRecord, submitted = false): string {
  if (submitted) {
    return `<div class="jf-form jf-form--success" role="status">${esc(form.data.successMessage)}</div>`;
  }
  const fields = form.data.fields
    .map((field) => {
      const control = inputHtml(field);
      return `<label class="jf-form__field" for="jf-form-${esc(field.name)}"><span>${esc(field.label)}${field.required ? " *" : ""}</span>${control}</label>`;
    })
    .join("");
  const heading = form.data.title ? `<h3 class="jf-form__title">${esc(form.data.title)}</h3>` : "";
  return `<form class="jf-form" method="post" action="/justflows-forms/submit">
    ${heading}
    <input type="hidden" name="formId" value="${esc(form.id)}">
    <label class="jf-form__hp" aria-hidden="true">Leave blank<input type="text" name="_gotcha" tabindex="-1" autocomplete="off"></label>
    ${fields}
    <button type="submit">${esc(form.data.submitLabel)}</button>
  </form>`;
}

export async function renderFormBlockHtml(props: Record<string, unknown>, submittedFormId?: string): Promise<string> {
  if (!(await isFormsPluginEnabled())) return "";
  const siteId = await getSiteId();
  if (!siteId) return "";
  const formId = String(props.formId ?? "contact");
  const form = await getForm(siteId, formId);
  if (form) return renderFormHtml(form, submittedFormId === form.id);

  const fields = String(props.fields ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (fields.length === 0) return `<p class="jf-form jf-form--missing">This form is no longer available.</p>`;
  const fallback: FormRecord = {
    id: "inline",
    data: {
      name: String(props.title ?? "Form"),
      title: String(props.title ?? ""),
      submitLabel: String(props.submitLabel ?? "Send"),
      successMessage: "Thanks, we received your message.",
      fields: fields.map((name) => ({
        id: name,
        name,
        label: name,
        type: name === "message" || name === "body" ? "textarea" : name === "email" ? "email" : "text",
        required: true,
      })),
    },
  };
  return renderFormHtml(fallback, submittedFormId === "inline");
}

/** Conservative address check for the Reply-To we derive from submitted data. */
const EMAIL_RE = /^[^\s@<>,;:"'\\()[\]]{1,64}@[a-z0-9.-]{1,255}\.[a-z]{2,}$/i;

export function safeReplyTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // CRLF would split the header; the installed nodemailer has open advisories
  // for exactly this, so reject rather than rely on the library encoding it.
  if (/[\r\n\0]/.test(trimmed)) return undefined;
  if (trimmed.length > 320) return undefined;
  return EMAIL_RE.test(trimmed) ? trimmed : undefined;
}

/** Strip anything that could break out of a mail header line. */
function headerText(value: string, max = 160): string {
  return value.replace(/[\r\n\0]/g, " ").trim().slice(0, max);
}

export async function acceptFormSubmission(input: {
  body: Record<string, unknown>;
  referer?: string;
  clientIp?: string;
}): Promise<{ status: number; location?: string; error?: string }> {
  // Unauthenticated write. Without a ceiling, a script fills plugin_data and
  // burns the site's SMTP quota; the honeypot below only stops naive bots.
  const ip = input.clientIp ?? "unknown";
  if (!consumeRateLimit(`form:ip:${ip}`, 10, 10 * 60 * 1000)) {
    return { status: 429, error: "Too many submissions. Please try again later." };
  }

  const siteId = await getSiteId();
  if (!siteId || !(await isFormsPluginEnabled(siteId))) {
    return { status: 404, error: "Forms are not available" };
  }
  if (String(input.body._gotcha ?? "").trim()) {
    return { status: 303, location: thankYouUrl(input.referer, String(input.body.formId ?? "")) };
  }
  const formId = String(input.body.formId ?? "").trim();
  const form = await getForm(siteId, formId);
  if (!form) return { status: 400, error: "Unknown form" };

  const values: Record<string, string> = {};
  for (const field of form.data.fields) {
    const raw = input.body[field.name];
    const value = field.type === "checkbox" ? (raw ? "yes" : "no") : String(raw ?? "").trim();
    if (field.required && (field.type === "checkbox" ? raw !== "1" && raw !== "on" && raw !== true : !value)) {
      return { status: 400, error: `${field.label} is required` };
    }
    values[field.name] = value.slice(0, 4000);
  }

  const createdAt = new Date().toISOString();
  await store(siteId).put("submissions", randomUUID(), {
    formId: form.id,
    formName: form.data.name,
    values,
    createdAt,
  } satisfies FormSubmission);

  void notifyFormSubmission(siteId, form.data.name, form.data.title, values);

  return { status: 303, location: thankYouUrl(input.referer, form.id) };
}

async function notifyFormSubmission(
  siteId: string,
  formName: string,
  formTitle: string,
  values: Record<string, string>,
): Promise<void> {
  try {
    const pluginNotify = await getPluginSetting<string>(FORMS_PLUGIN_ID, siteId, "notifyEmail");
    const general = await getGeneralSettings(siteId);
    const to =
      typeof pluginNotify === "string" && pluginNotify.includes("@")
        ? pluginNotify.trim()
        : general.adminEmail;
    if (!to) return;

    const lines = Object.entries(values)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    const replyTo = Object.entries(values).find(([key]) => key.toLowerCase().includes("email"))?.[1];
    const { sendMail } = await import("./mail.js");
    const label = headerText(formTitle || formName);
    await sendMail({
      to,
      subject: `Form submission: ${label}`,
      text: `A new submission was received for “${label}”.\n\n${lines}`,
      replyTo: safeReplyTo(replyTo),
    });
  } catch (err) {
    console.error("Form notification mail failed:", err);
  }
}

function thankYouUrl(referer: string | undefined, formId: string): string {
  try {
    const url = new URL(referer ?? "/", "http://localhost");
    url.searchParams.set("submitted", formId || "1");
    return `${url.pathname}${url.search}`;
  } catch {
    return formId ? `/?submitted=${encodeURIComponent(formId)}` : "/?submitted=1";
  }
}
