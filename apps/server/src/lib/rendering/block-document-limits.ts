// SPDX-License-Identifier: MIT

import type { NextFunction, Request, Response } from "express";
import { BLOCK_DOCUMENT_MAX_DEPTH, BLOCK_DOCUMENT_MAX_NODES, withinBlockDocumentLimits } from "@justflows/blocks";

/**
 * Refuses writes whose block documents are too deep or too large
 * (justflows-ce#309), before any route parses, stores or renders them.
 *
 * Every block list in the request body is measured without recursion: a
 * page's `blocks`, a header library's entries, a template, a reusable block,
 * a menu's mega-menu regions. A request over the limits gets 413 and changes
 * nothing. The sanitizer also cuts documents off at the same ceiling, so a
 * path this check does not cover (an assistant tool, an import) still cannot
 * store one that overflows the stack.
 */

const MAX_WALK = 100_000;

function oversizedList(body: unknown): boolean {
  const stack: unknown[] = [body];
  let seen = 0;
  while (stack.length) {
    const value = stack.pop();
    if (++seen > MAX_WALK) return true;
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      const looksLikeBlocks = value.some((item) => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string" && ("props" in item || "children" in item));
      if (looksLikeBlocks && !withinBlockDocumentLimits(value)) return true;
      /** Block lists are measured as a whole; other arrays are searched for nested documents. */
      if (!looksLikeBlocks) for (const item of value) stack.push(item);
      continue;
    }
    for (const item of Object.values(value as Record<string, unknown>)) stack.push(item);
  }
  return false;
}

export function rejectOversizedDocuments(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || !req.body || typeof req.body !== "object") {
    next();
    return;
  }
  if (oversizedList(req.body)) {
    res.status(413).json({
      error: `A block document may be at most ${BLOCK_DOCUMENT_MAX_DEPTH} levels deep and hold ${BLOCK_DOCUMENT_MAX_NODES} blocks.`,
      code: "document_too_large",
    });
    return;
  }
  next();
}
