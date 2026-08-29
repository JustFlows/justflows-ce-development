// SPDX-License-Identifier: MIT

import type { PluginSecretsApi } from "@justflows/sdk";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import {
  deletePluginSecretCipher,
  getPluginSecretCipher,
  setPluginSecretCipher,
} from "./plugin-kv.js";

const KEY_RE = /^[a-z0-9]+(?:[.:][a-z0-9]+)*$/;

export function createPluginSecretsApi(pluginId: string, siteId: string): PluginSecretsApi {
  return {
    async set(key, value) {
      if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
      await setPluginSecretCipher(pluginId, siteId, key, encryptSecret(value));
    },
    async get(key) {
      if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
      const stored = await getPluginSecretCipher(pluginId, siteId, key);
      const plain = decryptSecret(stored ?? "");
      return plain || undefined;
    },
    async has(key) {
      if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
      const stored = await getPluginSecretCipher(pluginId, siteId, key);
      return Boolean(stored);
    },
    async delete(key) {
      if (!KEY_RE.test(key)) throw new Error("Secret key must be dotted lowercase identifiers");
      await deletePluginSecretCipher(pluginId, siteId, key);
    },
  };
}
