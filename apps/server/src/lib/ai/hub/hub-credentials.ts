// SPDX-License-Identifier: MIT

/**
 * The hub never carries a credential in a tool call.
 *
 * Sites on an older Justflows version offer tools that ask for one, such as
 * an initial password for a new user. The hub leaves those tools out of
 * `tools/list` and refuses a `tools/call` that carries one, so a client
 * connected through it is never asked for a password, whatever version the
 * site runs. Such a site offers the tool again, without the credential, once
 * it is updated.
 */

/** Whole names, so `designTokens`, `cursor` or `passwordResetEnabled` are not credentials. */
const CREDENTIAL_NAME =
  /^(?:(?:[a-z]+)?(?:password|passwd|passphrase)|(?:client|app|api|webhook|signing)?secret|(?:client|app|api)?secretkey|apikey|privatekey|accesskey|signingkey|encryptionkey|(?:access|refresh|auth|bearer|api)token|credentials?|otp|mfacode|totpcode|recoverycodes?|backupcodes?)$/;

const MAX_DEPTH = 32;

export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** Whether a property schema can hold text. A switch named like a credential is not one. */
function holdsText(schema: unknown): boolean {
  const type = record(schema)?.type;
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => entry === "string" || entry === "object" || entry === "array");
}

/** Whether a tool's input schema asks for a credential at any level. */
export function asksForCredential(schema: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(schema)) return schema.some((item) => asksForCredential(item, depth + 1));
  const node = record(schema);
  if (!node) return false;
  for (const [name, property] of Object.entries(record(node.properties) ?? {})) {
    if (isCredentialName(name) && holdsText(property)) return true;
    if (asksForCredential(property, depth + 1)) return true;
  }
  return [node.items, node.additionalProperties, node.anyOf, node.oneOf, node.allOf, node.$defs && Object.values(node.$defs)].some(
    (part) => asksForCredential(part, depth + 1),
  );
}

/** Whether tool call arguments carry a credential at any level. */
export function carriesCredential(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => carriesCredential(item, depth + 1));
  const node = record(value);
  if (!node) return false;
  return Object.entries(node).some(
    ([name, item]) =>
      (isCredentialName(name) && item !== null && item !== "" && typeof item !== "boolean") ||
      carriesCredential(item, depth + 1),
  );
}

function messages(body: unknown): Json[] {
  return (Array.isArray(body) ? body : [body]).map(record).filter((item): item is Json => item !== null);
}

/**
 * The `tools/call` this body must be refused for, if any. Only tools whose
 * arguments carry a credential are refused; everything else is the site's to
 * judge.
 */
export function refusedCall(body: unknown): { id: unknown } | null {
  const call = messages(body).find(
    (message) => message.method === "tools/call" && carriesCredential(record(message.params)?.arguments),
  );
  return call ? { id: call.id ?? null } : null;
}

export function listsTools(body: unknown): boolean {
  return messages(body).some((message) => message.method === "tools/list");
}

/** A site's answer without the tools that ask for a credential. */
export function withoutCredentialTools(answer: unknown): unknown {
  if (Array.isArray(answer)) return answer.map(withoutCredentialTools);
  const message = record(answer);
  const result = record(message?.result);
  if (!message || !result || !Array.isArray(result.tools)) return answer;
  return {
    ...message,
    result: { ...result, tools: result.tools.filter((tool) => !asksForCredential(record(tool)?.inputSchema)) },
  };
}

/**
 * Rewrite a `tools/list` answer, JSON or a server-sent event stream. Null
 * when it cannot be read, so the caller fails instead of passing it on.
 */
export function filterToolList(text: string, contentType: string): string | null {
  try {
    if (!/^text\/event-stream\b/i.test(contentType)) return JSON.stringify(withoutCredentialTools(JSON.parse(text)));
    return text
      .split(/\r?\n\r?\n/)
      .map((event) => {
        const lines = event.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""));
        if (data.join("").trim() === "") return event;
        const rest = lines.filter((line) => !line.startsWith("data:"));
        return [...rest, `data: ${JSON.stringify(withoutCredentialTools(JSON.parse(data.join("\n"))))}`].join("\n");
      })
      .join("\n\n");
  } catch {
    return null;
  }
}
