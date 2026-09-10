// SPDX-License-Identifier: MIT

export { ContentService, NotFoundError, ConflictError } from "./service/content-service.js";
export { slugify, uniqueSlug } from "./service/slugify.js";
export {
  DEFAULT_REVISION_MAX_HISTORY,
  DEFAULT_AUTOSAVE_RETENTION_DAYS,
  REVISION_PRUNE_BATCH,
  overlaySnapshot,
  diffSnapshots,
  snapshotsEqual,
  selectHistoricalIdsToPrune,
  selectAutosaveIdsToPrune,
  visibleHistoricalRevisions,
} from "./service/revisions.js";
export type {
  RevisionKind,
  RevisionSource,
  ContentSnapshot,
  RevisionDiff,
  RevisionDiffEntry,
} from "./service/revisions.js";
export type {
  ContentItem,
  ContentRevision,
  ContentLiveSnapshot,
  CreateContentInput,
  UpdateContentInput,
  PublishContentInput,
  ContentQuery,
  ContentPage,
  BlockDocument,
  BlockNode,
  ContentStatus,
} from "./service/types.js";
export {
  BUILTIN_CONTENT_TYPES,
  BUILTIN_CONTENT_TYPE_SLUGS,
  CONTENT_TYPE_FIELD_KINDS,
  ContentFieldDefinitionSchema,
  ContentFieldKeySchema,
  ContentTypeFieldsSchema,
  ContentTypeSlugSchema,
  RESERVED_FIELD_KEYS,
  isBuiltinContentTypeSlug,
  normalizeContentTypeSlug,
} from "./service/content-types.js";
export type {
  BuiltinContentTypeSlug,
  ContentFieldDefinition,
  ContentFieldKind,
} from "./service/content-types.js";


export { SearchQuerySchema, searchTokens, searchHighlight } from "./search.js";
export type { SearchQuery } from "./search.js";
