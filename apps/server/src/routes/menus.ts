import { Router } from "express";
import { z } from "zod";
import { ContentTypeSlugSchema } from "@justflows/content";
import {
  PRIMARY_MENU_SLUG,
  createMenu,
  deleteMenu,
  getMenuBySlug,
  listMenus,
  updateMenu,
  type MenuItem,
} from "../lib/menus-db.js";
import { requireRole } from "../middleware/auth.js";
import { CONTENT_READ_ROLES, MENU_WRITE_ROLES } from "../lib/rbac.js";
import { param } from "../lib/params.js";
import { assertAllowedNavUrl } from "../lib/nav-url.js";
import { revalidateOnUpdate } from "../lib/cache-revalidate.js";
import { sendServerError } from "../lib/send-error.js";

const router = Router();

const MenuItemSchema: z.ZodType<MenuItem> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    label: z.string(),
    type: ContentTypeSlugSchema,
    url: z.string().optional(),
    contentId: z.string().uuid().optional(),
    target: z.enum(["_blank"]).optional(),
    children: z.array(MenuItemSchema).optional(),
  }),
);

const UpdateMenuSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  items: z.array(MenuItemSchema).optional(),
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

router.get("/:slug", requireRole(...CONTENT_READ_ROLES), async (req, res) => {
  try {
    const siteId = req.session!.siteId;
    const menu = await getMenuBySlug(siteId, param(req.params.slug));
    if (!menu) {
      res.status(404).json({ error: "Menu not found" });
      return;
    }
    res.json({ menu });
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
    const menu = await updateMenu(siteId, slug, body);
    if (!menu) {
      res.status(404).json({ error: "Menu not found" });
      return;
    }
    await revalidateOnUpdate("menus");
    res.json({ menu });
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
    await deleteMenu(siteId, slug);
    await revalidateOnUpdate("menus");
    res.json({ ok: true });
  } catch (err) {
    sendServerError(res, "menus", err);
  }
});

export default router;
