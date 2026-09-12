// SPDX-License-Identifier: MIT

import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { content } from "./content.js";
import { sites } from "./sites.js";

export const contentScheduleEvents = pgTable("content_schedule_events", {
  id: uuid("id").primaryKey(),
  contentId: uuid("content_id")
    .notNull()
    .references(() => content.id, { onDelete: "cascade" }),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 40 }).notNull(),
  payload: text("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
