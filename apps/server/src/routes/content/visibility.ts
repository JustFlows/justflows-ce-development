// SPDX-License-Identifier: MIT
import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { ANONYMOUS_VIEWER, ContentVisibilityPolicySchema, type ContentVisibilityViewer } from "@justflows/content";
import { getEffectiveAccess, userCan } from "../../lib/auth/access-policy.js";
import { getContentTypeSettings } from "../../lib/content/content-types-db.js";
import {
  applyVisibilityChange,
  getVisibilityOverride,
  saveVisibilityOverride,
  visibilityGroupId,
} from "../../lib/content/visibility-policies.js";
import { explainContentVisibility } from "../../lib/content/visibility-scope.js";
import { visibilityViewerFor } from "../../lib/content/visibility-viewer.js";
import { getDb } from "../../lib/database/db.js";
import { param } from "../../lib/http/params.js";
import { sendServerError } from "../../lib/http/send-error.js";
import { ensurePluginRuntime, getPluginLoader } from "../../lib/plugins/plugin-runtime.js";
import { auditLog } from "../../lib/security/audit-log.js";
import { getTenantContext } from "../../lib/tenancy/context.js";
import { requireSession } from "../../middleware/auth.js";

const router = Router();

const SaveSchema = z.object({ override: ContentVisibilityPolicySchema.nullable() }).strict();

const ExplainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("anonymous") }).strict(),
  z.object({ kind: z.literal("role"), role: z.string().trim().min(1).max(80) }).strict(),
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }).strict(),
]);

/** The item, once the caller is known to be allowed to edit it. Answers the request otherwise. */
async function editableRow(req: Request, res: Response): Promise<Record<string, unknown> | null> {
  const session = req.session!;
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    "SELECT id, site_id, type, slug, locale, translation_group_id, status, author_id FROM content WHERE id = ? AND site_id = ? AND trashed_at IS NULL LIMIT 1",
    [param(req.params.id), session.siteId],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const allowed = await userCan(session, "content:update", {
    contentType: String(row.type),
    locale: String(row.locale),
    ownerId: row.author_id as string | null,
  });
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return row;
}

const groupOf = (row: Record<string, unknown>) =>
  visibilityGroupId({
    id: String(row.id),
    translationGroupId: row.translation_group_id == null ? null : String(row.translation_group_id),
  });

/** Rule types active on this site, with their select options loaded. One failing plugin only loses its options. */
router.get("/rule-types", requireSession, async (req, res) => {
  try {
    const session = req.session!;
    const access = await getEffectiveAccess(session.userId, session.siteId, session.role);
    if (!access.capabilities.includes("content:read")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await ensurePluginRuntime();
    const active = getTenantContext()?.activePluginIds;
    const rules = (getPluginLoader()?.visibilityRuleRegistry.all() ?? []).filter(
      (rule) => active === undefined || active?.has(rule.pluginId),
    );
    const types = await Promise.all(
      rules.map(async (rule) => ({
        id: rule.registryId,
        label: rule.label,
        description: rule.description ?? "",
        fields: await Promise.all(
          (rule.fields ?? []).map(async ({ options, ...field }) => ({
            ...field,
            options: typeof options === "function" ? await options().catch(() => []) : (options ?? []),
          })),
        ),
      })),
    );
    res.json({ types });
  } catch (err) {
    sendServerError(res, "content-visibility", err);
  }
});

router.get("/content/:id", requireSession, async (req, res) => {
  try {
    const row = await editableRow(req, res);
    if (!row) return;
    const siteId = req.session!.siteId;
    const [override, settings] = await Promise.all([
      getVisibilityOverride(siteId, groupOf(row)),
      getContentTypeSettings(siteId, String(row.type)),
    ]);
    res.json({ override, typeDefault: settings.visibility });
  } catch (err) {
    sendServerError(res, "content-visibility", err);
  }
});

router.put("/content/:id", requireSession, async (req, res) => {
  const body = SaveSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message });
    return;
  }
  try {
    const row = await editableRow(req, res);
    if (!row) return;
    const session = req.session!;
    const group = groupOf(row);
    await saveVisibilityOverride(session.siteId, group, body.data.override, session.userId);
    const db = await getDb();
    const siblings = await db.query<{ id: string }>(
      "SELECT id FROM content WHERE site_id = ? AND COALESCE(translation_group_id, id) = ?",
      [session.siteId, group],
    );
    await applyVisibilityChange(session.siteId, siblings.map((sibling) => String(sibling.id)));
    void auditLog({
      siteId: session.siteId,
      action: "content.visibility_changed",
      actorId: session.userId,
      target: String(row.id),
      detail: body.data.override ? "Item visibility rule saved" : "Item visibility rule cleared",
    });
    res.json({ override: body.data.override });
  } catch (err) {
    sendServerError(res, "content-visibility", err);
  }
});

/** What a named viewer would get. Evaluated with the live rules, including plugin rules. */
router.post(
  "/content/:id/explain",
  requireSession,
  rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }),
  async (req, res) => {
    const body = ExplainSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid viewer" });
      return;
    }
    try {
      const row = await editableRow(req, res);
      if (!row) return;
      const siteId = req.session!.siteId;
      let viewer: ContentVisibilityViewer = ANONYMOUS_VIEWER;
      if (body.data.kind === "role") {
        viewer = { userId: null, roles: [body.data.role], authenticated: true };
      } else if (body.data.kind === "user") {
        const db = await getDb();
        const users = await db.query<{ id: string; role: string }>(
          "SELECT id, role FROM users WHERE id = ? AND site_id = ? LIMIT 1",
          [body.data.userId, siteId],
        );
        const user = users[0];
        if (!user) {
          res.status(404).json({ error: "User not found" });
          return;
        }
        viewer = await visibilityViewerFor(user.id, siteId, user.role);
      }
      res.json({ decision: await explainContentVisibility(siteId, row, viewer) });
    } catch (err) {
      sendServerError(res, "content-visibility", err);
    }
  },
);

export default router;
