import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES } from "../../lib/auth/rbac.js";
import { coreBlocks, resolveInlineFields, resolveInspectorSupports } from "@justflows/blocks";
import { getRuntimeBlockRegistry } from "../../lib/rendering/runtime-blocks.js";

const router = Router();

/** Only core blocks may declare rich inline fields; see `resolveInlineFields`. */
const CORE_TYPES = new Set(coreBlocks.map((def) => def.type));

/**
 * List registered block types for the page builder.
 *
 * Guarded: the only caller is the builder, and the response enumerates every
 * plugin-contributed block type and version — a precise inventory of which
 * extensions a site runs, which is the first thing worth knowing before
 * choosing an exploit.
 */
router.get("/", requireRole(...CONTENT_READ_ROLES), async (_req, res) => {
  const blocks = getRuntimeBlockRegistry().list().map((def) => ({
    type: def.type,
    version: def.version,
    title: def.title,
    description: def.description,
    icon: def.icon,
    category: def.category ?? "content",
    schema: def.schema,
    supportsChildren: def.supportsChildren ?? false,
    allowedChildTypes: def.allowedChildTypes,
    inspector: resolveInspectorSupports(def),
    inline: resolveInlineFields(def.inline, CORE_TYPES.has(def.type) && coreBlocks.includes(def)),
  }));
  res.json({ blocks });
});

/** Every builder keystroke can ask for a preview, so keep a ceiling per user. */
const previewLimit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false });

/**
 * A registered block's own render, for the builder preview of blocks the
 * builder has no preview for (plugin blocks). The builder sanitizes the HTML
 * before showing it. Children are not rendered.
 */
router.post("/preview", requireRole(...CONTENT_READ_ROLES), previewLimit, (req, res) => {
  const body = (req.body ?? {}) as { type?: unknown; props?: unknown };
  const type = typeof body.type === "string" ? body.type : "";
  const definition = type ? getRuntimeBlockRegistry().get(type) : undefined;
  if (!definition) {
    res.status(404).json({ error: "Unknown block type" });
    return;
  }
  try {
    const props = definition.validateProps(body.props ?? {});
    res.json({ html: String(definition.render(props as never, "") ?? "") });
  } catch {
    res.status(422).json({ error: "This block could not be previewed" });
  }
});

export default router;
