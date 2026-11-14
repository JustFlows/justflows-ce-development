import { z } from "zod";
import { withBlockChrome } from "../block-chrome.js";
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

  register(definition: BlockDefinition): void {
    if (this.blocks.has(definition.type)) {
      throw new Error(`Block type "${definition.type}" is already registered`);
    }
    this.blocks.set(definition.type, definition);
  }

  unregister(type: string): void {
    this.blocks.delete(type);
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
  renderNode(node: BlockRenderNode): string {
    const def = this.blocks.get(node.type);
    if (!def) {
      return `<!-- missing block: ${node.type} -->`;
    }
    const props = def.validateProps(node.props);
    const childrenHtml =
      node.children?.length && def.supportsChildren
        ? node.children.map((child) => this.renderNode(child)).join("\n")
        : "";
    return withBlockChrome(def.render(props, childrenHtml), node);
  }

  /** Render a full block document to HTML. */
  renderDocument(doc: { blocks: BlockRenderNode[] }): string {
    return doc.blocks.map((block) => this.renderNode(block)).join("\n");
  }
}
