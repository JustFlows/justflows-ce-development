// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import {
  compileDropPluginTables,
  compilePluginSchema,
  isPluginOwnedTable,
  listPluginOwnedTables,
  pluginOwnedTableLikePattern,
  pluginTablePrefix,
} from "../plugin-schema.js";

describe("plugin schema compiler", () => {
  it("prefixes tables with the plugin slug", () => {
    expect(pluginTablePrefix("justflows.shop")).toBe("shop");
    const compiled = compilePluginSchema(
      "justflows.shop",
      [
        {
          name: "products",
          columns: [
            { name: "id", type: "uuid", primary: true },
            { name: "site_id", type: "uuid", notNull: true },
            { name: "title", type: "varchar", length: 255, notNull: true },
          ],
          indexes: [{ name: "site", columns: ["site_id"] }],
        },
      ],
      "mysql",
    );
    expect(compiled[0]?.tableName).toBe("shop_products");
    expect(compiled[0]?.sql[0]).toContain("CREATE TABLE IF NOT EXISTS `shop_products`");
    expect(compiled[0]?.sql[0]).toContain("ENGINE=InnoDB");
    expect(compiled[0]?.sql[0]).toContain("KEY `idx_shop_products_site` (`site_id`)");
    expect(compiled[0]?.sql[0]).not.toMatch(/\busers\b/);
  });

  it("emits postgres types and separate indexes", () => {
    const compiled = compilePluginSchema(
      "justflows.shop",
      [
        {
          name: "orders",
          columns: [
            { name: "id", type: "uuid", primary: true },
            { name: "data", type: "json" },
            { name: "created_at", type: "timestamptz", notNull: true },
          ],
          indexes: [{ name: "created", columns: ["created_at"] }],
        },
      ],
      "postgres",
    );
    expect(compiled[0]?.sql[0]).toContain("JSONB");
    expect(compiled[0]?.sql[0]).toContain("TIMESTAMPTZ");
    expect(compiled[0]?.sql[1]).toBe(
      'CREATE INDEX IF NOT EXISTS "idx_shop_orders_created" ON "shop_orders" ("created_at")',
    );
  });

  it("quotes reserved MariaDB column names such as precision", () => {
    const compiled = compilePluginSchema(
      "justflows.shop",
      [
        {
          name: "stores",
          columns: [
            { name: "id", type: "uuid", primary: true },
            { name: "precision", type: "int", notNull: true },
            { name: "type", type: "varchar", length: 32, notNull: true },
          ],
        },
      ],
      "mysql",
    );
    expect(compiled[0]?.sql[0]).toContain("`precision` INT NOT NULL");
    expect(compiled[0]?.sql[0]).toContain("`type` VARCHAR(32) NOT NULL");
    expect(compiled[0]?.sql[0]).not.toMatch(/(?:^|\s)precision INT/);
  });

  it("emits unique indexes when requested", () => {
    const compiled = compilePluginSchema(
      "justflows.shop",
      [
        {
          name: "stores",
          columns: [
            { name: "id", type: "uuid", primary: true },
            { name: "site_id", type: "uuid", notNull: true },
          ],
          indexes: [{ name: "site", columns: ["site_id"], unique: true }],
        },
      ],
      "mysql",
    );
    expect(compiled[0]?.sql[0]).toContain("UNIQUE KEY `idx_shop_stores_site` (`site_id`)");
  });

  it("drops only plugin-prefixed tables and ignores core names", () => {
    expect(isPluginOwnedTable("justflows.shop", "shop_products")).toBe(true);
    expect(isPluginOwnedTable("justflows.shop", "users")).toBe(false);
    expect(isPluginOwnedTable("justflows.shop", "shopping_cart")).toBe(false);
    expect(pluginOwnedTableLikePattern("justflows.shop")).toBe("shop!_%");

    const mysql = compileDropPluginTables(
      "justflows.shop",
      ["shop_products", "users", "shop_orders"],
      "mysql",
    );
    expect(mysql[0]).toBe("SET FOREIGN_KEY_CHECKS=0");
    expect(mysql).toContain("DROP TABLE IF EXISTS `shop_products`");
    expect(mysql).toContain("DROP TABLE IF EXISTS `shop_orders`");
    expect(mysql.join("\n")).not.toMatch(/users/);
    expect(mysql.at(-1)).toBe("SET FOREIGN_KEY_CHECKS=1");

    const postgres = compileDropPluginTables("justflows.shop", ["shop_products"], "postgres");
    expect(postgres[0]).toBe('DROP TABLE IF EXISTS "shop_products" CASCADE');
    expect(compileDropPluginTables("justflows.shop", ["users"], "mysql")).toEqual([]);
  });

  it("lists only owned tables from information_schema rows", async () => {
    const query = vi.fn(async () => [
      { table_name: "shop_products" },
      { table_name: "users" },
      { TABLE_NAME: "shop_orders" },
    ]);
    const tables = await listPluginOwnedTables({ query }, "justflows.shop", "mysql");
    expect(tables).toEqual(["shop_products", "shop_orders"]);
    expect(query.mock.calls[0]?.[1]).toEqual(["shop!_%"]);
  });

  it("reads table names from Buffer column values", async () => {
    const query = vi.fn(async () => [{ table_name: Buffer.from("shop_carts") }]);
    const tables = await listPluginOwnedTables({ query }, "justflows.shop", "mysql");
    expect(tables).toEqual(["shop_carts"]);
  });

  it("rejects identifiers that could escape the plugin prefix", () => {
    expect(() =>
      compilePluginSchema(
        "justflows.shop",
        [{ name: "products; drop table users", columns: [{ name: "id", type: "uuid", primary: true }] }],
        "mysql",
      ),
    ).toThrow(/Invalid table/);
  });
});
