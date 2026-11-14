// SPDX-License-Identifier: MIT

import type { NextFunction, Request, Response } from "express";
import { getRuntimeBlockRegistry } from "./runtime-blocks.js";

/**
 * Blocks reach the builder at their current version (justflows-ce#305).
 *
 * A plugin block stored at an older `version` is upgraded with its declared
 * migrations before the editor sees it. Without this, the builder would show
 * and save the old props at the old version, and the render-time migration
 * would then rebuild new fields from old ones, losing the author's edits.
 * Nothing is written here: the upgraded document is stored when it is next
 * saved, and opening it does not mark it as changed.
 */

const MAX_DEPTH = 12;

function isBlockList(value: unknown[]): boolean {
  return value.length > 0 && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const node = item as Record<string, unknown>;
    return typeof node.type === "string" && (typeof node.props === "object" || Array.isArray(node.children));
  });
}

/** Every block list inside a response body, upgraded. Other values are returned unchanged. */
export function upgradeStoredBlocks<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (isBlockList(value)) return getRuntimeBlockRegistry().migrateBlocks(value) as T;
    let changed = false;
    const next = value.map((item) => {
      const upgraded = upgradeStoredBlocks(item, depth + 1);
      if (upgraded !== item) changed = true;
      return upgraded;
    });
    return (changed ? next : value) as T;
  }
  let out: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const upgraded = upgradeStoredBlocks(item, depth + 1);
    if (upgraded !== item) (out ??= { ...(value as Record<string, unknown>) })[key] = upgraded;
  }
  return (out ?? value) as T;
}

/** For the routes the builder loads documents from: upgrades block lists in GET responses. */
export function upgradeBlocksOnRead(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET") {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(upgradeStoredBlocks(body));
  }
  next();
}
