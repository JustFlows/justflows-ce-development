import type { BlockEditorMeta, BlockInlineFields, BlockInspectorSupports } from "@justflows/blocks";

export interface BlockNode {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  children?: BlockNode[];
  /** Editor-only label and lock flags; never rendered. See `docs/BUILDER-DOCUMENT.md`. */
  editor?: BlockEditorMeta;
}

export interface BlockDocument {
  version: 1;
  blocks: BlockNode[];
}

/** One plugin block prop as the inspector renders it (mirrors `PluginBlockField` in @justflows/sdk). */
export interface BlockSchemaField {
  type?: string;
  default?: unknown;
  options?: string[];
  optionLabels?: Record<string, string>;
  label?: string;
  help?: string;
  optionsUrl?: string;
  multiple?: boolean;
  showWhen?: { field: string; equals: string | string[] };
}

export interface BlockCatalogEntry {
  type: string;
  version: number;
  title: string;
  description?: string;
  icon?: string;
  category: string;
  supportsChildren: boolean;
  allowedChildTypes?: string[];
  schema?: Record<string, BlockSchemaField>;
  /** Generic settings sections this block offers in the inspector. */
  inspector?: BlockInspectorSupports;
  /** Props editable directly on the canvas (justflows-ce#297). */
  inline?: BlockInlineFields;
}

export type BlockPath = number[];
