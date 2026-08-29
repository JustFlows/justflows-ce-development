// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  appliedSchemaPasswordKey,
  appliedSchemaSettingKey,
  pluginSettingsLikePattern,
} from "../plugin-purge.js";

describe("plugin purge keys", () => {
  it("scopes settings deletes to the plugin's colon prefix", () => {
    expect(pluginSettingsLikePattern("justflows.shop")).toBe("plugin.justflows.shop:%");
    expect(pluginSettingsLikePattern("justflows.shop")).not.toContain("justflows.shopping");
    expect(appliedSchemaSettingKey("justflows.shop")).toBe("plugin_schema:justflows.shop");
    expect(appliedSchemaPasswordKey("justflows.shop")).toBe("plugin_schema:justflows.shop:password");
  });
});
