// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { pickSettingsSchema } from "../plugins-db.js";

describe("pickSettingsSchema", () => {
  it("prefers a live module schema over an empty stored row", () => {
    expect(
      pickSettingsSchema("justflows.shop", {}, {
        storeName: { type: "string", label: "Store name" },
      }),
    ).toEqual({ storeName: { type: "string", label: "Store name" } });
  });

  it("ignores an empty object so a later source can win", () => {
    expect(
      pickSettingsSchema(
        "justflows.shop",
        { settingsSchema: {} },
        { sandbox: { type: "boolean", label: "Sandbox" } },
      ),
    ).toEqual({ sandbox: { type: "boolean", label: "Sandbox" } });
  });
});
