import { Router } from "express";
import { z } from "zod";
import { ContentTypeSlugSchema } from "@justflows/content";
import {
  PRIMARY_MENU_SLUG,
  MENU_LAYOUTS,
  MENU_ACTIVATIONS,
  MENU_MOBILE_PATTERNS,
  MENU_MOBILE_MOTIONS,
  MENU_MOTION_MIN_MS,
  MENU_MOTION_MAX_MS,
  MENU_ALIGNMENTS,
  MENU_HARD_MAX_DEPTH,
  MENU_HARD_MAX_ITEMS_PER_LEVEL,
  MenuTreeShapeError,
  createMenu,
  deleteMenu,
  getEffectiveMenuDesign,
  getEffectiveMenuItems,
  getMenuBySlug,
  listMenus,
  parseMenuDesign,
  sanitizeMegaMenuRegions,
  updateMenu,
  validateMenuTreeShape,
  type MenuDesign,
  type MenuItem,
} from "../../lib/navigation/menus-db.js";
import type { BlockNode } from "../../lib/runtime/types.js";
import { listMenuDesignPresets } from "../../lib/navigation/menu-design-presets.js";
import { requireRole } from "../../middleware/auth.js";
import { CONTENT_READ_ROLES, MENU_WRITE_ROLES, STORED_ROLE_ID } from "../../lib/auth/rbac.js";
import { param } from "../../lib/http/params.js";
import { assertAllowedNavUrl } from "../../lib/navigation/nav-url.js";
import { isSafeAssetUrl } from "../../lib/media/favicon.js";
import { isSafeCssColor } from "../../lib/themes/theme-customize.js";
import { revalidateOnUpdate } from "../../lib/cache/cache-revalidate.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { auditFromRequest } from "../../lib/security/audit-log.js";

const router = Router();

const STYLE_PRESET_RE = /^[a-z][a-z0-9-]{0,39}$/;
const REL_TOKEN_RE = /^[a-z][a-z0-9-]{0,39}$/;

const MenuItemVisibilitySchema = z.object({
  auth: z.enum(["any", "guest", "authenticated"]).optional(),
  roles: z.array(z.string().regex(STORED_ROLE_ID)).max(10).optional(),
  locales: z.array(z.string().min(1).max(20)).max(50).optional(),
  devices: z.array(z.enum(["desktop", "tablet", "mobile"])).max(3).optional(),
  condition: z
    .object({
      id: z.string().min(1).max(120),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

const MenuItemDropdownSchema = z.object({
  trigger: z.enum(MENU_ACTIVATIONS).optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  width: z.union([z.enum(["auto", "menu", "viewport"]), z.number().min(100).max(2000)]).optional(),
  maxWidth: z.number().min(100).max(2000).optional(),
  columns: z.number().int().min(1).max(6).optional(),
  offsetX: z.number().int().min(-400).max(400).optional(),
  offsetY: z.number().int().min(-400).max(400).optional(),
  disableParentLink: z.boolean().optional(),
});

// Blocks are shape-checked loosely here; real sanitization (and the mega-menu
// safe-kind allowlist) is enforced by sanitizeMegaMenuRegions before persist.
const BlockNodeSchema: z.ZodType<BlockNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.string(),
    version: z.number(),
    props: z.record(z.string(), z.unknown()),
    children: z.array(BlockNodeSchema).optional(),
  }),
);

const MegaMenuRegionSchema = z.object({
  id: z.string().min(1),
  heading: z.string().max(200).optional(),
  span: z.number().int().min(1).max(12).optional(),
  blocks: z.array(BlockNodeSchema).max(60),
});

const MenuItemBadgeSchema = z.object({
  text: z.string().min(1).max(40),
  tone: z.enum(["info", "success", "warning", "danger"]).optional(),
});

const SafeCssColor = z.string().max(100).refine((v) => isSafeCssColor(v), "Unsafe CSS colour");
const MenuButtonStyleSchema = z.object({
  bg: SafeCssColor.optional(),
  fg: SafeCssColor.optional(),
  border: SafeCssColor.optional(),
  borderWidth: z.number().int().min(0).max(8).optional(),
  radius: z.number().int().min(0).max(40).optional(),
  size: z.enum(["sm", "md", "lg"]).optional(),
  fullWidth: z.boolean().optional(),
});

const MenuItemSchema: z.ZodType<MenuItem> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    label: z.string(),
    type: ContentTypeSlugSchema,
    url: z.string().optional(),
    contentId: z.string().uuid().optional(),
    target: z.enum(["_blank"]).optional(),
    rel: z
      .string()
      .max(120)
      .refine((v) => v.split(/\s+/).every((t) => REL_TOKEN_RE.test(t)), "Invalid rel token")
      .optional(),
    titleAttr: z.string().max(200).optional(),
    stylePreset: z.string().regex(STYLE_PRESET_RE).optional(),
    buttonStyle: MenuButtonStyleSchema.optional(),
    // Same asset-URL guard every other host image URL uses: a rooted path or an
    // http(s) URL only — no `data:`/`javascript:` and no scheme-relative `//`.
    icon: z.string().max(2048).refine(isSafeAssetUrl, "Unsafe icon URL").optional(),
    image: z.string().max(2048).refine(isSafeAssetUrl, "Unsafe image URL").optional(),
    badge: MenuItemBadgeSchema.optional(),
    description: z.string().max(500).optional(),
    visibility: MenuItemVisibilitySchema.optional(),
    dropdown: MenuItemDropdownSchema.optional(),
    megaMenu: z.object({ regions: z.array(MegaMenuRegionSchema).max(6) }).optional(),
    children: z.array(MenuItemSchema).optional(),
  }),
);

const MenuDesignSchema = z.object({
  layout: z.enum(MENU_LAYOUTS),
  activation: z.enum(MENU_ACTIVATIONS),
  breakpoint: z.number().min(320).max(1400),
  // Accept the legacy "drawer" value from older clients, mapping it to "drawer-right".
  mobilePattern: z.preprocess((v) => (v === "drawer" ? "drawer-right" : v), z.enum(MENU_MOBILE_PATTERNS)),
  mobileMotion: z.enum(MENU_MOBILE_MOTIONS).optional(),
  mobileMotionMs: z.number().int().min(MENU_MOTION_MIN_MS).max(MENU_MOTION_MAX_MS).optional(),
  alignment: z.enum(MENU_ALIGNMENTS),
  maxDepth: z.number().int().min(1).max(MENU_HARD_MAX_DEPTH),
  maxItemsPerLevel: z.number().int().min(1).max(MENU_HARD_MAX_ITEMS_PER_LEVEL),
  presetId: z.string().max(80).optional(),
});

const UpdateMenuSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  items: z.array(MenuItemSchema).optional(),
  design: MenuDesignSchema.optional(),
  /** true = write the working draft only (admin preview); false/absent = publish. */
  draft: z.boolean().optional(),
});

const CreateMenuSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens"),
  name: z.string().min(1).max(255),
});

function validateMenuItems(items: MenuItem[]): void {
  for (const item of items) {
    if (item.type === "custom") {
      assertAllowedNavUrl(item.url);
    }
    if (item.megaMenu) {
      item.megaMenu.regions = sanitizeMegaMenuRegions(item.megaMenu.regions);
    }
    if (item.children?.length) validateMenuItems(item.children);
  }
}

router.get("/", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const siteId = req.session!.siteId;
    const menus = await listMenus(siteId);
    res.json({ menus });
  } catch (err) {
    sendServerError(res, "menus", err);
  }
});

router.get("/design-presets", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const siteId = req.session!.siteId;
    const presets = await listMenuDesignPresets(siteId);
    res.json({ presets });
  } catch (err) {
    sendServerError(res, "menus", err);
  }
});

router.get("/:slug", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const siteId = req.session!.siteId;
    const preview = req.query.preview === "1";
    const menu = await getMenuBySlug(siteId, param(req.params.slug));
    if (!menu) {
      res.status(404).json({ error: "Menu not found" });
      return;
    }
    res.json({
      menu: {
        ...menu,
        items: getEffectiveMenuItems(menu, preview),
        design: getEffectiveMenuDesign(menu, preview),
      },
      hasDraft: Boolean(menu.draftItems || menu.draftDesign),
    });
  } catch (err) {
    sendServerError(res, "menus", err);
  }
});

router.put("/:slug", requireRole(...MENU_WRITE_ROLES), async (req, res) => {
  try {
    const body = UpdateMenuSchema.parse(req.body);
    if (body.items) validateMenuItems(body.items);
    const siteId = req.session!.siteId;
    const slug = param(req.params.slug);

    const existing = await getMenuBySlug(siteId, slug);
    if (!existing) {
      res.status(404).json({ error: "Menu not found" });
      return;
    }

    const design: MenuDesign = body.design
      ? parseMenuDesign(body.design)
      : getEffectiveMenuDesign(existing, Boolean(body.draft));
    if (body.items) {
      try {
        validateMenuTreeShape(body.items, design);
      } catch (err) {
        if (err instanceof MenuTreeShapeError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    const menu = await updateMenu(siteId, slug, { ...body, design: body.design && design });
    if (!menu) {
      res.status(404).json({ error: "Menu not found" });
      return;
    }
    // A draft save must not appear on the public site; only a publish does.
    // The JF cache prefix wipe below covers both — the preview render path
    // reads draft columns directly, live requests never do.
    await revalidateOnUpdate("menus");
    res.json({ menu, draft: Boolean(body.draft) });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.post("/", requireRole(...MENU_WRITE_ROLES), async (req, res) => {
  try {
    const body = CreateMenuSchema.parse(req.body);
    const siteId = req.session!.siteId;

    const existing = await getMenuBySlug(siteId, body.slug);
    if (existing) {
      res.status(409).json({ error: "A menu with this slug already exists" });
      return;
    }

    const menu = await createMenu(siteId, body.slug, body.name);
    await revalidateOnUpdate("menus");
    res.json({ menu });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

router.delete("/:slug", requireRole(...MENU_WRITE_ROLES), async (req, res) => {
  try {
    const slug = param(req.params.slug);
    if (slug === PRIMARY_MENU_SLUG) {
      res.status(400).json({ error: "The primary menu cannot be deleted" });
      return;
    }

    const siteId = req.session!.siteId;
    await deleteMenu(siteId, slug, req.session!.userId);
    await revalidateOnUpdate("menus");
    auditFromRequest(req, "trash.trashed", { target: slug, detail: "type=menu" });
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "menus", err);
  }
});

export default router;
