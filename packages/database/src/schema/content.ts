import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sites } from "./sites.js";
import { users } from "./users.js";

export const contentStatusEnum = pgEnum("content_status", [
  "draft",
  "scheduled",
  "published",
  "unpublished",
  "trashed",
]);

export const content = pgTable("content", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 60 }).notNull().default("post"),
  title: varchar("title", { length: 1024 }).notNull(),
  slug: varchar("slug", { length: 1024 }).notNull(),
  excerpt: text("excerpt"),
  blocks: jsonb("blocks").notNull().default([]),
  status: contentStatusEnum("status").notNull().default("draft"),
  authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
  publishOn: timestamp("publish_on", { withTimezone: true }),
  unpublishOn: timestamp("unpublish_on", { withTimezone: true }),
  scheduleActorId: uuid("schedule_actor_id"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  trashedAt: timestamp("trashed_at", { withTimezone: true }),
  trashedBy: uuid("trashed_by").references(() => users.id, { onDelete: "set null" }),
  originalSlug: varchar("original_slug", { length: 1024 }),
  originalStatus: contentStatusEnum("original_status"),
  version: integer("version").notNull().default(1),
});

export type Content = typeof content.$inferSelect;
export type NewContent = typeof content.$inferInsert;
