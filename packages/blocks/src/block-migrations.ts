// SPDX-License-Identifier: MIT

/**
 * Explicit, versioned migrations for stored block nodes.
 *
 * A block type's `version` says which shape its `props` have. When a block's
 * schema changes in a way old props cannot satisfy, the block ships a
 * migration from version N to N+1 instead of guessing at read time. The
 * migrator applies those steps to a document and never mutates its input, so
 * the pre-migration document is always available for rollback (callers keep
 * it, typically as a content revision, before writing the migrated copy).
 *
 * Failure is deterministic and lossless: a node whose migration throws,
 * returns a non-object, or has a gap in its chain keeps its original props and
 * version and is reported. Unknown block types and nodes newer than any known
 * migration (for example after a plugin downgrade) are left untouched.
 */

import { BLOCK_DOCUMENT_VERSION } from "./document-contract.js";

export interface BlockMigration {
  /** Block type this step belongs to, e.g. `core.image` or `acme.slider`. */
  type: string;
  /** Version the props are in before this step. */
  from: number;
  /** Must be `from + 1`. */
  to: number;
  /** Return the props for version `to`. Must be pure and must not mutate its input. */
  migrate(props: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

export type BlockMigrationFailureReason =
  | "migration-threw"
  | "migration-invalid-result"
  | "missing-step"
  | "future-version"
  | "unsupported-document-version";

export interface BlockMigrationFailure {
  reason: BlockMigrationFailureReason;
  /** Index path to the node; empty for a document-level failure. */
  path: number[];
  id?: string;
  type?: string;
  /** The node's stored version. */
  version?: number;
  message?: string;
}

export interface BlockMigrationResult<D> {
  document: D;
  /** True when at least one node was migrated. */
  changed: boolean;
  failures: BlockMigrationFailure[];
}

interface MigratableNode {
  id?: unknown;
  type?: unknown;
  version?: unknown;
  props?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

/**
 * Holds every migration step known to this process and applies them.
 * Registration rejects duplicate steps and steps that skip a version, so a
 * broken chain is caught when an extension loads, not when a page is read.
 */
export class BlockMigrator {
  private readonly steps = new Map<string, Map<number, BlockMigration>>();

  register(migration: BlockMigration): void {
    const { type, from, to } = migration;
    if (!type || !Number.isInteger(from) || from < 1 || to !== from + 1) {
      throw new Error(`Block migration for "${type}" must go from an integer version N >= 1 to N + 1`);
    }
    const chain = this.steps.get(type) ?? new Map<number, BlockMigration>();
    if (chain.has(from)) {
      throw new Error(`Block migration for "${type}" from version ${from} is already registered`);
    }
    chain.set(from, migration);
    this.steps.set(type, chain);
  }

  /** Remove every step for a type, e.g. when its plugin deactivates. */
  unregisterType(type: string): void {
    this.steps.delete(type);
  }

  /** The newest version this migrator can bring a type to, or `undefined` when it has no steps. */
  latestVersion(type: string): number | undefined {
    const chain = this.steps.get(type);
    if (!chain?.size) return undefined;
    return Math.max(...[...chain.values()].map((step) => step.to));
  }

  /**
   * Migrate a block list toward `targets` (type → current registered version).
   * A type missing from `targets` migrates as far as its registered chain goes.
   */
  migrateBlocks<T>(blocks: T[], targets: ReadonlyMap<string, number> = new Map()): BlockMigrationResult<T[]> {
    const failures: BlockMigrationFailure[] = [];
    let changed = false;

    const visitNode = (raw: T, path: number[]): T => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const node = raw as MigratableNode;
      let next: MigratableNode = node;

      const migrated = this.migrateNode(node, targets, path, failures);
      if (migrated) {
        next = migrated;
        changed = true;
      }

      if (Array.isArray(node.children)) {
        const children = node.children.map((child, i) => visitNode(child as T, [...path, i]));
        if (children.some((child, i) => child !== (node.children as unknown[])[i])) {
          next = { ...next, children };
        }
      }
      return next as T;
    };

    const document = blocks.map((block, i) => visitNode(block, [i]));
    return { document: changed ? document : blocks, changed, failures };
  }

  /** Migrate a whole stored document. Only document version 1 exists today. */
  migrateDocument<D extends { version?: unknown; blocks?: unknown }>(
    doc: D,
    targets?: ReadonlyMap<string, number>,
  ): BlockMigrationResult<D> {
    if (doc.version !== BLOCK_DOCUMENT_VERSION) {
      return {
        document: doc,
        changed: false,
        failures: [{ reason: "unsupported-document-version", path: [], message: String(doc.version) }],
      };
    }
    if (!Array.isArray(doc.blocks)) return { document: doc, changed: false, failures: [] };
    const result = this.migrateBlocks(doc.blocks as unknown[], targets);
    return {
      document: result.changed ? { ...doc, blocks: result.document } : doc,
      changed: result.changed,
      failures: result.failures,
    };
  }

  private migrateNode(
    node: MigratableNode,
    targets: ReadonlyMap<string, number>,
    path: number[],
    failures: BlockMigrationFailure[],
  ): MigratableNode | null {
    const type = typeof node.type === "string" ? node.type : "";
    const chain = type ? this.steps.get(type) : undefined;
    if (!chain) return null;

    const stored = typeof node.version === "number" && Number.isInteger(node.version) ? node.version : 1;
    const target = targets.get(type) ?? this.latestVersion(type) ?? stored;
    const report = (reason: BlockMigrationFailureReason, message?: string) =>
      failures.push({
        reason,
        path,
        ...(typeof node.id === "string" ? { id: node.id } : {}),
        type,
        version: stored,
        ...(message ? { message } : {}),
      });

    if (stored > target) {
      report("future-version");
      return null;
    }
    if (stored === target) return null;

    let props: Record<string, unknown> =
      node.props && typeof node.props === "object" && !Array.isArray(node.props)
        ? { ...(node.props as Record<string, unknown>) }
        : {};
    for (let version = stored; version < target; version++) {
      const step = chain.get(version);
      if (!step) {
        report("missing-step", `no migration from version ${version}`);
        return null;
      }
      let result: unknown;
      try {
        result = step.migrate(Object.freeze({ ...props }));
      } catch (error) {
        report("migration-threw", error instanceof Error ? error.message : String(error));
        return null;
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        report("migration-invalid-result");
        return null;
      }
      props = { ...(result as Record<string, unknown>) };
    }
    return { ...node, version: target, props };
  }
}
