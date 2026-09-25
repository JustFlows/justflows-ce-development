export interface BlockNode {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  children?: BlockNode[];
}

export interface BlockDocument {
  version: 1;
  blocks: BlockNode[];
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
  schema?: Record<string, { type?: string; default?: unknown; options?: string[] }>;
}

export type BlockPath = number[];
