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

export { contentTypePolicy, publicContentTypeSql } from "./service/content-types.js";
export {
  ANONYMOUS_VIEWER,
  CONTENT_VISIBILITY_REASON_RE,
  CONTENT_VISIBILITY_RULE_ID_RE,
  ContentVisibilityPolicySchema,
  ContentVisibilityRuleRefSchema,
  decideContentVisibility,
  isOpenVisibilityPolicy,
} from "./service/visibility.js";
export type {
  ContentVisibilityDecider,
  ContentVisibilityDecision,
  ContentVisibilityPolicy,
  ContentVisibilityRuleOutcome,
  ContentVisibilityRuleRef,
  ContentVisibilityRuleRunner,
  ContentVisibilityViewer,
} from "./service/visibility.js";
export { DEFAULT_ACCOUNT_BLOCKS, seedAccountPage } from "./service/account-page.js";
export { AUTH_PAGES, AUTH_PAGE_SLUGS, DEFAULT_AUTH_BLOCKS, defaultAuthBlocks, seedAuthPages } from "./service/auth-page.js";
export type { AuthPageSlug } from "./service/auth-page.js";

export { ContentCacheFieldsSchema, validateContentCacheFields, effectiveContentCacheControl, ContentTypeCacheControlSchema, NEVER_CACHE_CONTROL, normalizeCacheControl, cacheControlPolicy } from "./service/cache-control.js";
export { ContentTypeSettingsSchema, resolveContentTypeSettings } from "./service/content-type-settings.js";
export type { ContentTypeSettings } from "./service/content-type-settings.js";
