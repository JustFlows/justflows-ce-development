// SPDX-License-Identifier: MIT
import { sql } from "drizzle-orm";
import { customType, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { content } from "./content.js";
import { sites } from "./sites.js";
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
export const searchDocuments = pgTable(
  "search_documents",
  {
    contentId: uuid("content_id")
      .primaryKey()
      .references(() => content.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary").notNull(),
    body: text("body").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', slug), 'B') || setweight(to_tsvector('simple', summary), 'C') || setweight(to_tsvector('simple', body), 'D')`,
    ),
  },
  (table) => [
    index("search_documents_site").on(table.siteId),
    index("search_documents_fts").using("gin", table.searchVector),
  ],
);

export const searchMetrics = pgTable(
  "search_metrics",
  {
    id: uuid("id").primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    tokenCount: integer("token_count").notNull(),
    resultCount: integer("result_count").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("search_metrics_site_created").on(table.siteId, table.createdAt)],
);
