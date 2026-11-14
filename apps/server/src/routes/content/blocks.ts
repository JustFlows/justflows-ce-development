import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES } from "../../lib/auth/rbac.js";
import { coreBlocks, resolveInlineFields, resolveInspectorSupports, type BlockContract, type BlockDefinition } from "@justflows/blocks";
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
  const registry = getRuntimeBlockRegistry();
  const blocks = registry.list().map((def) => {
    const contract = registry.contractOf(def.type);
    return {
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
      /** The Builder 2.0 editor contract (justflows-ce#305), already normalized. */
      ...(contract ? editorContract(def, contract) : {}),
    };
  });
  res.json({ blocks });
});

/**
 * What the builder needs from a block's contract. Defaults are run through
 * the block's own `validateProps`, so a new block starts from values the
 * block accepts; a definition whose validator throws offers none.
 */
function editorContract(def: BlockDefinition, contract: BlockContract): Record<string, unknown> {
  let defaults: Record<string, unknown> | undefined;
  if (contract.defaults) {
    try {
      defaults = def.validateProps(contract.defaults) as Record<string, unknown>;
    } catch {
      defaults = undefined;
    }
  }
  return {
    apiVersion: contract.apiVersion,
    ...(contract.keywords.length ? { keywords: contract.keywords } : {}),
    ...(contract.parents.length ? { parents: contract.parents } : {}),
    ...(defaults ? { defaults } : {}),
    ...(contract.deprecated ? { deprecated: contract.deprecated } : {}),
    ...(contract.actions.length ? { actions: contract.actions } : {}),
    preview: { mode: contract.preview.mode, ...(contract.preview.minHeight ? { minHeight: contract.preview.minHeight } : {}) },
    supports: { containerLayout: Boolean(contract.supports.containerLayout) },
  };
}

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
  const contract = getRuntimeBlockRegistry().contractOf(type);
  if (contract?.preview.mode === "placeholder") {
    res.json({ html: "", placeholder: true });
    return;
  }
  try {
    /**
     * Older stored props are upgraded first, and the block's sample props fill
     * what the author has not set yet (justflows-ce#305). The result still goes
     * through the block's `validateProps`, and the builder sanitizes the HTML.
     */
    const raw = body.props && typeof body.props === "object" && !Array.isArray(body.props) ? (body.props as Record<string, unknown>) : {};
    const version = typeof (body as { version?: unknown }).version === "number" ? (body as { version: number }).version : definition.version;
    const migrated = getRuntimeBlockRegistry().migrateNode({ type, version, props: raw });
    const props = definition.validateProps({ ...(contract?.preview.sampleProps ?? {}), ...stripEmpty(migrated.props as Record<string, unknown>) });
    res.json({ html: String(definition.render(props as never, "") ?? "") });
  } catch {
    res.status(422).json({ error: "This block could not be previewed" });
  }
});

/** Props the author left empty, so sample props can stand in for them in a preview. */
function stripEmpty(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== "" && value !== null && value !== undefined));
}

export default router;
