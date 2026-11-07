// SPDX-License-Identifier: MIT
import { z } from "zod";
import { contentTypePolicy } from "./content-types.js";
import { ContentVisibilityPolicySchema } from "./visibility.js";

/** Optional overrides preserve the behavior of existing installations. */
export const ContentTypeSettingsSchema = z
  .object({
    pluralLabel: z.string().trim().max(255).default(""),
    quickAction: z.boolean().nullable().default(null),
    editor: z.enum(["auto", "blocks", "fields"]).default("auto"),
    revisions: z.boolean().default(true),
    preview: z.boolean().default(true),
    search: z.boolean().nullable().default(null),
    seo: z.boolean().default(true),
    comments: z.enum(["inherit", "enabled", "disabled"]).default("inherit"),
    /** Who may view entries of this type unless an entry overrides it. Null keeps them public. */
    visibility: ContentVisibilityPolicySchema.nullable().default(null),
  })
  .strict();
export type ContentTypeSettings = z.infer<typeof ContentTypeSettingsSchema>;

/** Privacy-sensitive built-ins cannot be made discoverable by type settings. */
export function resolveContentTypeSettings(slug: string, raw?: unknown): ContentTypeSettings {
  /** Stored rows may carry retired keys; drop them instead of resetting every setting. */
  const parsed = ContentTypeSettingsSchema.strip().safeParse(raw ?? {});
  const settings = parsed.success ? parsed.data : ContentTypeSettingsSchema.parse({});
  if (!contentTypePolicy(slug).publiclyDiscoverable) {
    return { ...settings, search: false, seo: false, comments: "disabled", visibility: null };
  }
  return settings;
}
