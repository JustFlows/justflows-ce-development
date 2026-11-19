import { randomBytes } from "node:crypto";
import type { HooksRegistry } from "@justflows/core";
import { applyEnvToProcess, readEnvMap, updateEnvKeys } from "../settings/env-file.js";

/**
 * A plugin asks for an operator key through the `operatorKey.ensure` hook.
 * The host writes it to `.env` when it is missing. The value stays out of the
 * database and is never returned. A plugin may only name a key under its own
 * id: `justflows.example` may use `JUSTFLOWS_EXAMPLE_*`, and a third-party
 * `acme.example` may use `JUSTFLOWS_EXT_ACME__EXAMPLE_*`. The `EXT_` marker and
 * the double underscore for the dot keep the two forms from colliding: ids
 * never contain `--`, so `__` can only come from a dot.
 */

const OFFICIAL_PLUGIN_ID = /^justflows\.([a-z][a-z0-9-]{0,40})$/;
const THIRD_PARTY_PLUGIN_ID = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

export interface OperatorKeyStore {
  env: NodeJS.ProcessEnv;
  read(name: string): Promise<string | undefined>;
  write(name: string, value: string): Promise<void>;
}

/** The env prefix this plugin is allowed to create. */
export function operatorKeyPrefix(pluginId: string): string | null {
  const envPart = (value: string) => value.replace(/-/g, "_").toUpperCase();
  const official = OFFICIAL_PLUGIN_ID.exec(pluginId)?.[1];
  if (official) {
    /** `justflows.ext-*` would own the `JUSTFLOWS_EXT_` keys of third-party plugins. */
    if (official === "ext" || official.startsWith("ext-")) return null;
    return `JUSTFLOWS_${envPart(official)}_`;
  }
  const thirdParty = THIRD_PARTY_PLUGIN_ID.exec(pluginId);
  if (!thirdParty || thirdParty[1] === "justflows" || pluginId.length > 60) return null;
  return `JUSTFLOWS_EXT_${envPart(thirdParty[1]!)}__${envPart(thirdParty[2]!)}_`;
}

/** True when `name` is a key this plugin may create. */
export function operatorKeyAllowed(pluginId: string, name: string): boolean {
  const prefix = operatorKeyPrefix(pluginId);
  if (!prefix || !name.startsWith(prefix) || name.length > 64) return false;
  return /^[A-Z0-9_]+$/.test(name.slice(prefix.length));
}

/** 64 hex characters, or standard base64 of 32 bytes, as lowercase hex. */
export function canonicalOperatorKey(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32 && decoded.toString("base64") === trimmed) return decoded.toString("hex");
  return null;
}

async function ensureKey(name: string, store: OperatorKeyStore): Promise<void> {
  const live = canonicalOperatorKey(store.env[name]);
  if (live) {
    if (store.env[name] !== live) store.env[name] = live;
    return;
  }
  const stored = canonicalOperatorKey(await store.read(name));
  const value = stored ?? randomBytes(32).toString("hex");
  if (!stored) await store.write(name, value);
  store.env[name] = value;
}

const fileStore: OperatorKeyStore = {
  env: process.env,
  async read(name) {
    return (await readEnvMap()).get(name);
  },
  async write(name, value) {
    await updateEnvKeys({ [name]: value });
    applyEnvToProcess({ [name]: value });
  },
};

/** Create `name` for `pluginId` when it is missing. Rejects another plugin's name. */
export async function ensureOperatorKey(
  pluginId: string,
  name: string,
  store: OperatorKeyStore = fileStore,
): Promise<void> {
  if (!operatorKeyAllowed(pluginId, name)) {
    throw new Error("That operator key is outside this plugin's name.");
  }
  await ensureKey(name, store);
}

const hooked = new WeakSet<HooksRegistry>();

/** Host handler for `operatorKey.ensure`. The loader supplies the calling plugin id. */
export function registerOperatorKeyHook(hooks: HooksRegistry): void {
  if (hooked.has(hooks)) return;
  hooked.add(hooks);
  hooks.filter<{ name: string }, { pluginId?: string }>("operatorKey.ensure", async (value, context) => {
    await ensureOperatorKey(context.pluginId ?? "", value.name);
    return value;
  });
}
