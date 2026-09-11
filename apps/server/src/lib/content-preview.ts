// SPDX-License-Identifier: MIT

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const PreviewSchema = z
  .object({
    contentId: z.string().uuid(),
    siteId: z.string().uuid(),
    version: z.number().int().positive(),
    expires: z.number().int().positive(),
  })
  .strict();
export type ContentPreview = z.infer<typeof PreviewSchema>;
function signature(value: string): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) throw new Error("Preview signing is unavailable");
  return createHmac("sha256", secret)
    .update("justflows:content-preview:v1:")
    .update(value)
    .digest();
}
export function createContentPreview(
  input: Omit<ContentPreview, "expires">,
  now = Date.now(),
): string {
  const payload = PreviewSchema.parse({ ...input, expires: now + 24 * 60 * 60_000 });
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${value}.${signature(value).toString("base64url")}`;
}
export function verifyContentPreview(token: unknown, now = Date.now()): ContentPreview | null {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const expected = signature(parts[0]!);
    const supplied = Buffer.from(parts[1]!, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const result = PreviewSchema.safeParse(
      JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
    );
    return result.success && result.data.expires > now ? result.data : null;
  } catch {
    return null;
  }
}
