import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { sites } from "./sites.js";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  username: varchar("username", { length: 60 }).notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 32 }).notNull().default("subscriber"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
