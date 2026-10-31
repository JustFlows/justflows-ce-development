// SPDX-License-Identifier: MIT

import type { PluginSecretsApi } from "@justflows/sdk";
import { decryptSecret, encryptSecret } from "../security/secret-box.js";
import {
  deletePluginSecretCipher,
  getPluginSecretCipher,
  setPluginSecretCipher,
} from "./plugin-kv.js";
import { pluginCallSiteId } from "./request-site.js";

const KEY_RE = /^[a-z0-9]+(?:[.:][a-z0-9]+)*$/;

/** Read one of this plugin's secrets on a chosen site. The key rules match `ctx.secrets`. */
export async function readPluginSecret(pluginId: string, siteId: string, key: string): Promise<string | undefined> {
  if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
  const stored = await getPluginSecretCipher(pluginId, siteId, key);
  const plain = decryptSecret(stored ?? "");
  return plain || undefined;
}

/** Whether that site has a stored value for the key. The value itself stays unread. */
export async function pluginSecretExists(pluginId: string, siteId: string, key: string): Promise<boolean> {
  if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
  const stored = await getPluginSecretCipher(pluginId, siteId, key);
  return Boolean(stored);
}

export function createPluginSecretsApi(pluginId: string, activatedSiteId: string): PluginSecretsApi {
  const siteId = () => pluginCallSiteId(activatedSiteId);
  return {
    async set(key, value) {
      if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
      await setPluginSecretCipher(pluginId, siteId(), key, encryptSecret(value));
    },
    async get(key) {
      return readPluginSecret(pluginId, siteId(), key);
    },
    async has(key) {
      return pluginSecretExists(pluginId, siteId(), key);
    },
    async delete(key) {
      if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
      await deletePluginSecretCipher(pluginId, siteId(), key);
    },
  };
}
