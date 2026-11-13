// SPDX-License-Identifier: MIT

import { z } from "zod";

export const PATTERN_FORMAT_VERSION = 1 as const;
export const PATTERN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const BLOCK_TYPE_RE = /^[a-z0-9][a-z0-9.-]{1,119}$/;

/**
 * Editor-only node metadata (navigator label, accidental-change locks). It is
 * never rendered; the host normalizes it again when the pattern is stored.
 */
export interface PatternBlockEditorMeta {
  label?: string | undefined;
  lock?: { move?: boolean | undefined; remove?: boolean | undefined; edit?: boolean | undefined } | undefined;
}

export const PatternBlockEditorMetaSchema: z.ZodType<PatternBlockEditorMeta> = z
  .object({
    label: z.string().max(200).optional(),
    lock: z
      .object({ move: z.boolean().optional(), remove: z.boolean().optional(), edit: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

export interface PatternBlock {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  children?: PatternBlock[] | undefined;
  editor?: PatternBlockEditorMeta | undefined;
}

export const PatternBlockSchema: z.ZodType<PatternBlock> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1).max(128),
      type: z.string().regex(BLOCK_TYPE_RE),
      version: z.number().int().positive(),
      props: z.record(z.string(), z.unknown()).default({}),
      children: z.array(PatternBlockSchema).optional(),
      editor: PatternBlockEditorMetaSchema.optional(),
    })
    .strict(),
);

export const PatternLocaleSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    blocks: z.array(PatternBlockSchema).max(500).optional(),
  })
  .strict();

export const BlockPatternSchema = z
  .object({
    schemaVersion: z.literal(PATTERN_FORMAT_VERSION).default(PATTERN_FORMAT_VERSION),
    id: z.string().regex(PATTERN_SLUG_RE),
    title: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    category: z.string().regex(PATTERN_SLUG_RE).default("sections"),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default("1.0.0"),
    requiresBlockTypes: z.array(z.string().regex(BLOCK_TYPE_RE)).max(100).default([]),
    blocks: z.array(PatternBlockSchema).min(1).max(500),
    locales: z
      .record(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), PatternLocaleSchema)
      .optional(),
  })
  .strict()
  .superRefine((pattern, ctx) => {
    const used = new Set<string>();
    const visit = (blocks: z.infer<typeof PatternBlockSchema>[]) => {
      for (const block of blocks) {
        if (!block.type.startsWith("core.")) used.add(block.type);
        if (block.children) visit(block.children as z.infer<typeof PatternBlockSchema>[]);
      }
    };
    visit(pattern.blocks);
    for (const type of used) {
      if (!pattern.requiresBlockTypes.includes(type)) {
        ctx.addIssue({
          code: "custom",
          path: ["requiresBlockTypes"],
          message: `Non-core block ${type} must be declared in requiresBlockTypes`,
        });
      }
    }
  });

export const PatternSetSchema = z
  .object({
    schemaVersion: z.literal(PATTERN_FORMAT_VERSION),
    patterns: z.array(BlockPatternSchema).min(1).max(200),
  })
  .strict();

export const ThemePatternRegistrationSchema = z.union([
  z.string().regex(/^\.\/patterns\/[A-Za-z0-9_-]+\.json$/),
  z
    .object({
      path: z.string().regex(/^\.\/patterns\/[A-Za-z0-9_-]+\.json$/),
      requiresBlockTypes: z.array(z.string().regex(BLOCK_TYPE_RE)).max(100).default([]),
    })
    .strict(),
]);

export type BlockPattern = z.infer<typeof BlockPatternSchema>;
export type PatternSet = z.infer<typeof PatternSetSchema>;
export type ThemePatternRegistration = z.infer<typeof ThemePatternRegistrationSchema>;
