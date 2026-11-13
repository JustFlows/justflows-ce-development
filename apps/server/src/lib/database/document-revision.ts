// SPDX-License-Identifier: MIT

/**
 * A write to a revisioned document (template parts, theme template overrides)
 * named a revision that is no longer current: someone else saved in between.
 * Routes answer it with 409 `{ code: "document_conflict" }` (justflows-ce#302).
 */
export class DocumentRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super("This document was changed by someone else since you opened it");
    this.name = "DocumentRevisionConflictError";
  }
}

/** The 409 body for a revision conflict. */
export function documentConflictBody(err: DocumentRevisionConflictError): Record<string, unknown> {
  return {
    error: err.message,
    code: "document_conflict",
    expectedRevision: err.expectedRevision,
    actualRevision: err.actualRevision,
  };
}

/** Stored revision column value as a number; rows written before the column existed read as 1. */
export function revisionOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 1;
}
