import { z } from "zod";
import { isMarkableBlockType, withBlockChrome } from "../block-chrome.js";
import { BLOCK_DOCUMENT_MAX_DEPTH } from "../sanitize-document.js";
import { BlockMigrator } from "../block-migrations.js";
import { normalizeBlockContract, type BlockAction, type BlockContract, type BlockDeprecation, type BlockMigrationStep, type BlockPreviewContract, type BlockSupports } from "../block-contract.js";
import { registerContainerLayoutTarget, unregisterContainerLayoutTarget } from "../container-layout.js";
import type { BlockInspectorSupports } from "../inspector.js";
import type { BlockInlineFields } from "../inline.js";

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "number"
  | "boolean"
  | "select"
  | "media"
  | "url"
  /** A list of `{ src, alt, caption }` images, edited with upload and the media library. */
  | "images";

export interface BlockSchema {
  [field: string]: {
    type: FieldType;
    required?: boolean;
    default?: unknown;
    options?: string[]; // for select
    /** Inspector hints for plugin blocks; see `PluginBlockField` in @justflows/sdk. */
    optionLabels?: Record<string, string>;
    label?: string;
    help?: string;
    optionsUrl?: string;
    multiple?: boolean;
    showWhen?: { field: string; equals: string | string[] };
  };
}

export interface BlockDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  /** Immutable, namespaced block type, e.g. "core.paragraph" or "acme.hero" */
  type: string;
  version: number;
  title: string;
  description?: string;
  icon?: string;
  /** UI grouping: layout | sections | content | media */
  category?: string;
  schema: BlockSchema;
  /** Whether this block can contain child blocks */
  supportsChildren?: boolean;
  allowedChildTypes?: string[];
  /** Which generic builder settings sections this block offers; see `INSPECTOR_SECTIONS`. */
  inspector?: BlockInspectorSupports;
  /** Props an author may edit directly on the canvas; see `inline.ts`. */
  inline?: BlockInlineFields;
  /** Editor contract version (justflows-ce#305); see `block-contract.ts`. Defaults to 1. */
  apiVersion?: number;
  /** Extra words the block library search matches. */
  keywords?: string[];
  /** Parent types this block may be placed in (`$root` for a region root). */
  parents?: string[];
  /** Props a newly inserted block starts with, passed through `validateProps`. */
  defaults?: Record<string, unknown>;
  /** Hidden from the library; existing blocks keep rendering. */
  deprecated?: BlockDeprecation | true;
  /** One-click prop changes offered in the block's menu and toolbar. */
  actions?: BlockAction[];
  /** How the builder previews the block. */
  preview?: BlockPreviewContract;
  /** Host features the block takes part in. */
  supports?: BlockSupports;
  /** Steps that upgrade stored props from an older `version`, one version at a time. */
  migrations?: BlockMigrationStep[];
  /** Render block props to HTML string (server render) */
  render(props: P, children?: string): string;
  /** Validate and coerce props against the schema */
  validateProps(raw: unknown): P;
}

export interface BlockRenderNode {
  type: string;
  props: Record<string, unknown>;
  children?: BlockRenderNode[];
  /** Stored block id. Scopes the block's own CSS; absent for ad-hoc renders. */
  id?: string;
}

export class BlockRegistry {
  private readonly blocks = new Map<string, BlockDefinition>();
  private readonly contracts = new Map<string, BlockContract>();
  private readonly migrator = new BlockMigrator();

  /**
   * Register a definition. Its editor contract is checked first: an
   * unsupported `apiVersion` or an incomplete migration chain is refused here,
   * at activation, instead of failing later on a page.
   */
  register(definition: BlockDefinition): void {
    if (this.blocks.has(definition.type)) {
      throw new Error(`Block type "${definition.type}" is already registered`);
    }
    const contract = normalizeBlockContract(definition as unknown as Record<string, unknown>);
    for (const step of contract.migrations) {
      this.migrator.register({ type: definition.type, from: step.from, to: step.to, migrate: step.migrate });
    }
    if (contract.supports.containerLayout) registerContainerLayoutTarget(definition.type, contract.supports.containerLayout.target);
    this.contracts.set(definition.type, contract);
    this.blocks.set(definition.type, definition);
  }

  unregister(type: string): void {
    this.blocks.delete(type);
    this.contracts.delete(type);
    this.migrator.unregisterType(type);
    unregisterContainerLayoutTarget(type);
  }

  /** The normalized editor contract of a registered type. */
  contractOf(type: string): BlockContract | undefined {
    return this.contracts.get(type);
  }

  /**
   * A stored node brought up to its type's registered version, when the type
   * declares migrations. Lossless: a failed step keeps the stored props.
   */
  migrateNode<T extends { type: string; props?: unknown; version?: unknown }>(node: T): T {
    return this.migrateNodeResult(node).node;
  }

  /**
   * Like `migrateNode`, and says whether an upgrade step failed. The node is
   * then returned as stored, so the builder can show it and say why
   * (justflows-ce#306).
   */
  migrateNodeResult<T extends { type: string; props?: unknown; version?: unknown }>(node: T): { node: T; failed: boolean } {
    const def = this.blocks.get(node.type);
    if (!def || !this.contracts.get(node.type)?.migrations.length) return { node, failed: false };
    const result = this.migrator.migrateBlocks([{ ...node, children: undefined }], new Map([[node.type, def.version]]));
    const failed = result.failures.length > 0;
    return { node: failed || !result.changed ? node : ({ ...(result.document[0] as T), children: (node as { children?: unknown }).children } as T), failed };
  }

  /**
   * Upgrade every node in a block list (children included) whose type
   * declares migrations and is stored at an older version. Returns the input
   * itself when nothing changed. A failing step keeps that node as stored.
   */
  migrateBlocks<T>(blocks: T[]): T[] {
    const targets = new Map<string, number>();
    for (const [type, contract] of this.contracts) {
      if (contract.migrations.length) targets.set(type, this.blocks.get(type)!.version);
    }
    if (!targets.size) return blocks;
    return this.migrator.migrateBlocks(blocks, targets).document;
  }

  get(type: string): BlockDefinition | undefined {
    return this.blocks.get(type);
  }

  list(): BlockDefinition[] {
    return Array.from(this.blocks.values());
  }

  /**
   * Render a block node to HTML. If the block type is unknown, emit a
   * missing-block placeholder so stored data is never lost.
   */
  renderNode(node: BlockRenderNode, depth = 1): string {
    const def = this.blocks.get(node.type);
    if (!def) {
      /**
       * The stored type is author input: only a well-formed block id is
       * echoed, so a crafted type cannot close the comment and inject markup.
       */
      return isMarkableBlockType(node.type) ? `<!-- missing block: ${node.type} -->` : "<!-- missing block -->";
    }
    const migrated = this.migrateNode(node as BlockRenderNode & { version?: unknown });
    const props = def.validateProps(migrated.props);
    /** Past the document ceiling, nested blocks are not rendered (justflows-ce#309). */
    const childrenHtml =
      node.children?.length && def.supportsChildren && depth < BLOCK_DOCUMENT_MAX_DEPTH
        ? node.children.map((child) => this.renderNode(child, depth + 1)).join("\n")
        : "";
    return withBlockChrome(def.render(props, childrenHtml), node);
  }

  /** Render a full block document to HTML. */
  renderDocument(doc: { blocks: BlockRenderNode[] }): string {
    return doc.blocks.map((block) => this.renderNode(block)).join("\n");
  }
}
