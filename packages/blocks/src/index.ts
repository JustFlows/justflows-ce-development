// SPDX-License-Identifier: MIT

export { BlockRegistry } from "./registry/block-registry.js";
export type {
  BlockDefinition,
  BlockSchema,
  FieldType,
  BlockRenderNode,
} from "./registry/block-registry.js";
export { coreBlocks } from "./core/index.js";
export { sanitizeRichText, sanitizeHtmlBlock, sanitizePlainText, extractPlainText, sanitizePluginPreviewHtml } from "./sanitize.js";
export { renderMath } from "./math.js";
export { sanitizeBlockDocument } from "./sanitize-document.js";
export { esc, safeHref, safeMediaSrc, sanitizeHref, sanitizeMediaSrc } from "./safe-url.js";
export { renderResponsiveImage, sanitizeSizes, sanitizeSrcset } from "./responsive-image.js";
export type { ResponsiveImageInput, ResponsiveSource } from "./responsive-image.js";
export {
  ANIMATION_EASINGS,
  ANIMATION_TRIGGERS,
  DEFAULT_BLOCK_ANIMATION,
  ENTRANCE_EFFECTS,
  ENTRANCE_VARIANTS,
  HOVER_EFFECTS,
  HOVER_VARIANTS,
  TAP_EFFECTS,
  TAP_VARIANTS,
  blockAnimationCss,
  compactBlockAnimation,
  isActiveAnimation,
  parseBlockAnimation,
  sanitizeAnimationProp,
  withBlockAnimation,
} from "./animation.js";
export type {
  AnimationEasing,
  AnimationTrigger,
  BlockAnimation,
  EntranceEffect,
  HoverEffect,
  MotionVariant,
  TapEffect,
} from "./animation.js";
export { blockAssetMarker, isMarkableBlockType, markBlockTypes, withBlockChrome } from "./block-chrome.js";
export {
  CORE_INSPECTOR_SUPPORTS,
  DEFAULT_INSPECTOR_SUPPORTS,
  INSPECTOR_FIELDS,
  INSPECTOR_SECTIONS,
  resolveInspectorSupports,
} from "./inspector.js";
export type {
  BlockInspectorSupports,
  InspectorField,
  InspectorSection,
  ResolvedInspectorSupports,
} from "./inspector.js";
export {
  BLOCK_VISIBILITY_CSS,
  DEVICE_BUCKETS,
  DEVICE_MAX_MOBILE,
  DEVICE_MAX_TABLET,
  blockVisibilityCss,
  deviceVisibilityAttr,
  normalizeDeviceList,
} from "./visibility.js";
export type { DeviceBucket } from "./visibility.js";
export {
  DEFAULT_BLOCK_PLACEMENT,
  GRID_DEFAULT_COLUMNS,
  GRID_MAX_COLUMNS,
  GRID_MIN_COLUMNS,
  compactBlockPlacement,
  isDefaultPlacement,
  isPlacementShaped,
  parseBlockPlacement,
  placementStyleVars,
  sanitizePlacementProp,
} from "./layout.js";
export type { BlockPlacement } from "./layout.js";
export {
  ALIGN_SELF,
  BASIS_PRESETS,
  DEFAULT_BLOCK_STYLE,
  GROW_VALUES,
  OVERFLOW_VALUES,
  RADIUS_PRESETS,
  SHADOW_PRESETS,
  SPACE_STEPS,
  TEXT_ALIGN,
  WIDTH_PRESETS,
  blockStyleDeclarations,
  compactBlockStyle,
  flexBasis,
  isDefaultBlockStyle,
  parseBlockStyle,
  sanitizeBlockStyleProp,
} from "./block-style.js";
export type { BlockStyle, SpaceStep } from "./block-style.js";
export type { BlockChromeNode } from "./block-chrome.js";
export {
  blockScopeClass,
  decodeCssEscapes,
  hasUnsafeCss,
  normalizeCssForChecks,
  sanitizeBlockClassName,
  sanitizeBlockCss,
  scopeBlockCss,
  stripCssComments,
} from "./safe-css.js";

import { BlockRegistry } from "./registry/block-registry.js";
import { coreBlocks } from "./core/index.js";

/** Create a BlockRegistry pre-loaded with all core blocks */
export function createBlockRegistrySync(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const block of coreBlocks) registry.register(block);
  return registry;
}

export { functionalBlockCss } from "./functional-css.js";

export {
  BLOCK_DOCUMENT_VERSION,
  BLOCK_ID_MAX_LENGTH,
  BLOCK_MAX_DEPTH,
  BLOCK_NODE_KEYS,
  EDITOR_LABEL_MAX_LENGTH,
  EDITOR_LOCK_FLAGS,
  ROOT_PARENT,
  canNestBlock,
  isValidBlockId,
  reassignBlockIds,
  repairBlockIds,
  sanitizeEditorMeta,
  validateBlockDocument,
} from "./document-contract.js";
export type {
  BlockDocumentIssue,
  BlockDocumentIssueCode,
  BlockEditorMeta,
  BlockIdFactory,
  BlockNestingInfo,
  BlockNestingLookup,
  CanonicalBlockDocument,
  CanonicalBlockNode,
  EditorLockFlag,
  ValidateBlockDocumentOptions,
} from "./document-contract.js";
export {
  BREAKPOINT_LAYOUT_FIELDS,
  BREAKPOINT_PLACEMENT_FIELDS,
  BREAKPOINT_STYLE_FIELDS,
  CONTAINER_ALIGN,
  CONTAINER_DIRECTIONS,
  CONTAINER_DISPLAYS,
  CONTAINER_ELEMENTS,
  CONTAINER_JUSTIFY,
  CONTAINER_STACK,
  CONTAINER_WRAPS,
  OVERRIDE_BREAKPOINTS,
  STYLE_REF_RE,
  VALUE_SOURCES,
  sanitizeBlockBreakpoints,
  sanitizeContainerLayout,
  sanitizeStyleRef,
} from "./builder-values.js";
export type {
  BlockBreakpoints,
  BreakpointOverride,
  BreakpointStyleField,
  ContainerLayout,
  OverrideBreakpoint,
  ValueSource,
} from "./builder-values.js";
export { BlockMigrator } from "./block-migrations.js";
export type {
  BlockMigration,
  BlockMigrationFailure,
  BlockMigrationFailureReason,
  BlockMigrationResult,
} from "./block-migrations.js";
export {
  INLINE_FIELD_ATTRIBUTE,
  INLINE_FIELD_MODES,
  INLINE_FORMATS,
  normalizeInlineValue,
  resolveInlineFields,
} from "./inline.js";
export type { BlockInlineFields, InlineFieldMode, InlineFieldSpec, InlineFormat } from "./inline.js";
export { blockLockFlags, blockLockViolations, isBlockLocked } from "./block-locks.js";
export type { BlockLockRule, BlockLockViolation } from "./block-locks.js";
export {
  BLOCK_CLIPBOARD_FORMAT,
  BLOCK_CLIPBOARD_MAX_CHARS,
  BLOCK_CLIPBOARD_MAX_NODES,
  BLOCK_CLIPBOARD_MIME,
  looksLikeBlockClipboard,
  parseBlockClipboard,
  plainTextToBlocks,
  serializeBlockClipboard,
} from "./block-clipboard.js";
export type { BlockClipboardParse, BlockClipboardPayload, ClipboardBlock } from "./block-clipboard.js";
export {
  CONTAINER_ELEMENT_TYPES,
  CONTAINER_LAYOUT_CSS,
  CONTAINER_LAYOUT_TARGETS,
  applyContainerLayout,
  containerElementAllowed,
  containerLayoutAttrs,
  containerLayoutCss,
  supportsContainerLayout,
} from "./container-layout.js";
export type { ContainerLayoutAttrs } from "./container-layout.js";
