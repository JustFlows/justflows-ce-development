// SPDX-License-Identifier: MIT

/**
 * The canonical block document contract shared by every builder surface:
 * pages, posts, revisions, headers, the footer, theme templates, reusable
 * blocks, patterns, widget areas, and mega-menu regions.
 *
 * See `docs/BUILDER-DOCUMENT.md` for the architecture decision this module
 * implements. Everything here is pure and framework-free so the server, the
 * admin builder, and tests apply the same rules.
 */

/** The only document version that exists. A future version ships with a document migration. */
export const BLOCK_DOCUMENT_VERSION = 1 as const;

/**
 * The keys a stored block node may carry. Anything else on a node is transient
 * editor state (selection, drag, hover, panel state) and is dropped when the
 * document is sanitized, so it can never reach the database or public output.
 */
export const BLOCK_NODE_KEYS = ["id", "type", "version", "props", "children", "editor"] as const;

/** Upper bound for a stored block id; matches the pattern schema in `@justflows/sdk`. */
export const BLOCK_ID_MAX_LENGTH = 128;

/** Deepest nesting the validator accepts. Real documents stay far below this. */
export const BLOCK_MAX_DEPTH = 32;

/** Longest editor-only label, in characters. */
export const EDITOR_LABEL_MAX_LENGTH = 80;

/** What a lock can prevent. Each flag is stored only when true. */
export const EDITOR_LOCK_FLAGS = ["move", "remove", "edit"] as const;
export type EditorLockFlag = (typeof EDITOR_LOCK_FLAGS)[number];

/**
 * Persisted editor-only metadata for a node. It is never passed to a block's
 * `render` or `validateProps` and never appears in public HTML.
 */
export interface BlockEditorMeta {
  /** A name shown in the navigator instead of the block type. Plain text. */
  label?: string;
  /** Guards against accidental changes. Enforced by the editor, not a permission. */
  lock?: Partial<Record<EditorLockFlag, true>>;
}

/** One node of the canonical document. */
export interface CanonicalBlockNode {
  id: string;
  type: string;
  /** The block type's schema version this node was last saved with. */
  version: number;
  props: Record<string, unknown>;
  children?: CanonicalBlockNode[];
  editor?: BlockEditorMeta;
}

export interface CanonicalBlockDocument {
  version: typeof BLOCK_DOCUMENT_VERSION;
  blocks: CanonicalBlockNode[];
}

/**
 * A stored block id: 1–128 characters, no whitespace or markup characters.
 * Existing ids (UUIDs, theme slugs such as `hero-1`) all satisfy this.
 */
export function isValidBlockId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= BLOCK_ID_MAX_LENGTH &&
    !/[\s<>"'`&]/.test(value)
  );
}

/** Strip control characters and markup-significant brackets, collapse whitespace. */
function plainLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EDITOR_LABEL_MAX_LENGTH);
}

/**
 * Normalize a node's `editor` value, or `undefined` when nothing meaningful is
 * left. Unknown keys are dropped so this object cannot become a side channel.
 */
export function sanitizeEditorMeta(raw: unknown): BlockEditorMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: BlockEditorMeta = {};
  const label = plainLabel(input["label"]);
  if (label) out.label = label;
  const lockRaw = input["lock"];
  if (lockRaw && typeof lockRaw === "object" && !Array.isArray(lockRaw)) {
    const lock: Partial<Record<EditorLockFlag, true>> = {};
    for (const flag of EDITOR_LOCK_FLAGS) {
      if ((lockRaw as Record<string, unknown>)[flag] === true) lock[flag] = true;
    }
    if (Object.keys(lock).length > 0) out.lock = lock;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What the nesting rules need to know about a block type. */
export interface BlockNestingInfo {
  supportsChildren?: boolean;
  allowedChildTypes?: string[];
  /** Parents this block may sit in; `$root` is a region root. Empty means no restriction (justflows-ce#305). */
  parents?: string[];
}

/** Resolves a block type to its nesting info, or `undefined` for an unknown type. */
export type BlockNestingLookup = (type: string) => BlockNestingInfo | undefined;

/**
 * Parent value meaning "the root of a region" (document body, header slot,
 * footer, template). The root accepts any block except a bare column.
 */
export const ROOT_PARENT = null;

/**
 * Whether a block of `childType` may sit directly inside `parentType`.
 *
 * `parentType` is `null` for a region root. These rules were previously only
 * in the admin drag-and-drop code; they live here so moves, pastes, imports,
 * and server validation all agree.
 */
export function canNestBlock(
  parentType: string | null,
  childType: string,
  lookup: BlockNestingLookup,
): boolean {
  if (childType === "core.column") return parentType === "core.columns";
  /** A block that names its parents may only sit in one of them. */
  const childParents = lookup(childType)?.parents;
  if (childParents?.length && !childParents.includes(parentType === null ? "$root" : parentType)) return false;
  if (parentType === null) return true;

  const parent = lookup(parentType);
  if (!parent?.supportsChildren) return false;
  if (parent.allowedChildTypes?.length) return parent.allowedChildTypes.includes(childType);

  if (parentType === "core.columns") return false;
  if (parentType === "core.column") return childType !== "core.columns";
  return true;
}

export type BlockDocumentIssueCode =
  | "invalid-node"
  | "missing-id"
  | "invalid-id"
  | "duplicate-id"
  | "unknown-type"
  | "invalid-parent"
  | "cycle"
  | "max-depth";

export interface BlockDocumentIssue {
  code: BlockDocumentIssueCode;
  /** Index path from the root list to the offending node. */
  path: number[];
  /** The node's id when it has a usable one. */
  id?: string;
  type?: string;
}

export interface ValidateBlockDocumentOptions {
  /**
   * Resolve block types. When omitted, type and nesting checks are skipped and
   * only structure and ids are checked.
   */
  lookup?: BlockNestingLookup;
  /** Type of the container the root list sits in; `null` for a region root. */
  rootParentType?: string | null;
  maxDepth?: number;
}

/**
 * Check a block list against the contract without changing it.
 *
 * Validation reports; it never repairs. Callers decide what an issue means:
 * the editor refuses an invalid move, an import reassigns duplicate ids, and
 * the renderer keeps rendering (unknown blocks become placeholders). The
 * result is deterministic: issues come out in document order.
 */
export function validateBlockDocument(
  blocks: unknown,
  options: ValidateBlockDocumentOptions = {},
): BlockDocumentIssue[] {
  const issues: BlockDocumentIssue[] = [];
  const seenIds = new Set<string>();
  const ancestors = new Set<object>();
  const maxDepth = options.maxDepth ?? BLOCK_MAX_DEPTH;
  const lookup = options.lookup;

  const visit = (list: unknown, parentType: string | null, path: number[]): void => {
    if (!Array.isArray(list)) return;
    if (path.length >= maxDepth) {
      if (list.length > 0) issues.push({ code: "max-depth", path });
      return;
    }
    list.forEach((raw, index) => {
      const at = [...path, index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        issues.push({ code: "invalid-node", path: at });
        return;
      }
      if (ancestors.has(raw)) {
        issues.push({ code: "cycle", path: at });
        return;
      }
      const node = raw as Record<string, unknown>;
      const type = typeof node["type"] === "string" ? (node["type"] as string) : "";
      const id = node["id"];
      const base = { path: at, ...(type ? { type } : {}) };

      if (!type) issues.push({ code: "invalid-node", ...base });

      if (id === undefined || id === null || id === "") {
        issues.push({ code: "missing-id", ...base });
      } else if (!isValidBlockId(id)) {
        issues.push({ code: "invalid-id", ...base });
      } else if (seenIds.has(id)) {
        issues.push({ code: "duplicate-id", id, ...base });
      } else {
        seenIds.add(id);
      }

      const withId = isValidBlockId(id) ? { id } : {};
      if (lookup && type) {
        if (!lookup(type)) issues.push({ code: "unknown-type", ...withId, ...base });
        else if (!canNestBlock(parentType, type, lookup)) {
          issues.push({ code: "invalid-parent", ...withId, ...base });
        }
      }

      ancestors.add(raw);
      visit(node["children"], type || null, at);
      ancestors.delete(raw);
    });
  };

  visit(blocks, options.rootParentType ?? null, []);
  return issues;
}

/** Produces a fresh block id. The admin passes its UUID helper; tests pass a counter. */
export type BlockIdFactory = () => string;

function mapTree<T extends { children?: T[] }>(blocks: T[], fn: (node: T) => T): T[] {
  return blocks.map((node) => {
    const next = fn(node);
    return node.children ? { ...next, children: mapTree(node.children, fn) } : next;
  });
}

/**
 * Give every node in a copied subtree a new id. Copy, duplicate, paste, and
 * pattern insertion use this; move and reparent never do, so a moved block
 * keeps its id (and with it its scoped CSS and any references to it).
 */
export function reassignBlockIds<T extends { id?: unknown; children?: T[] }>(
  blocks: T[],
  makeId: BlockIdFactory,
): T[] {
  return mapTree(blocks, (node) => ({ ...node, id: makeId() }));
}

/**
 * Fill in missing or invalid ids and replace later duplicates, keeping every
 * id that is already valid and first in document order. Use this when
 * importing data from outside the editor; normal saves never need it.
 */
export function repairBlockIds<T extends { id?: unknown; children?: T[] }>(
  blocks: T[],
  makeId: BlockIdFactory,
): T[] {
  const seen = new Set<string>();
  const fresh = (): string => {
    let id = makeId();
    while (seen.has(id)) id = makeId();
    return id;
  };
  return mapTree(blocks, (node) => {
    const id = node.id;
    if (isValidBlockId(id) && !seen.has(id)) {
      seen.add(id);
      return node;
    }
    const next = fresh();
    seen.add(next);
    return { ...node, id: next };
  });
}
