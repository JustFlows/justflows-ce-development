# Performance and database access

Agents and contributors must use these rules for list rendering, bulk operations, background jobs, and persistence helpers. Optimize the smallest coherent path and leave unrelated working-tree changes alone.

## Read shared data once

Trace the complete call chain before moving code. A harmless-looking `contentPermalink()`, settings getter, or reference checker can execute several queries. Count queries for one item and a larger list; query growth should follow bounded batches or distinct sites/locales rather than individual items when data can be shared.

Pass an operation-scoped resolver or snapshot through the call chain. Use `contentPermalinks()` for a content list, or `createContentPermalinkResolver()` when processing items incrementally. Reuse preloaded permalink state, locale, terms, and home pages where available. Resolve categories through a content-ID index. Share SEO settings between identity and head rendering for the same site and locale. Load and serialize reference documents once when checking multiple media items.

Never introduce a process-global settings snapshot to hide duplicate reads. Reuse must respect the selected database, tenant/site, locale, preview state, and authorization. Long-lived caches need the established cache keys and invalidation contract. Do not reuse a stale reference check to authorize a later destructive operation.

## Batch database work

Use parameterized `IN` queries, multi-row statements, or existing bulk APIs for independent records in the same operation. Keep `site_id` and any status/kind guard in every statement. Handle empty input without emitting `IN ()`. Deduplicate only when the contract allows it. Bound parameter counts and statement size; process large inputs in chunks or use keyset pagination.

`Promise.all(items.map(async item => query(item)))` executes one query per item and can exhaust the pool. Batch first. Use concurrency only for genuinely independent operations, and bound it for large inputs. Do not parallelize dependent statements or work on one held transaction connection without proving it is supported.

Some loops are required: per-file storage actions, plugin hooks, audit records, provider calls, cursor pagination, and operations with different authorization or locking requirements. Preserve these semantics rather than blindly replacing every loop with one statement. In particular, search indexing locks source rows to avoid overwriting newer edits; batching must preserve that invariant.

## Avoid repeated scans

When a loop repeatedly calls `find`, `filter`, or `includes` on another growing collection, build an index once. Use an ID-to-row map, a membership set, or a frequency map for duplicate detection. Preserve original output ordering and the previous first-match behavior. Several clear O(n) passes are usually better than a complicated single pass; target nested scans and repeated expensive serialization first.

## Preserve behavior and verify

Before editing, identify tenant ownership, locale fallback, preview overlays, timestamps, original status, deletion guards, hooks, audits, notifications, locks, cache invalidation, and error handling. Keep these intact. Avoid removing a read needed for concurrency control merely because the same row was read earlier.

Regression tests should cover realistic multi-item inputs and bounded query counts, plus supported JSON representations and database identifier quoting. Cover empty input, repeated IDs or paths, cross-site isolation, locale fallback, and failure paths where relevant. Mocked tests prove the query contract, not live SQL execution; run disposable PostgreSQL/MySQL/MariaDB integration suites when available and state when they were not run. Do not use the installed development or production database for destructive tests.


## Private account routes

The frontend `/account` page and its APIs must never enter a shared response cache.
See [Frontend user account](HOOKS.md#frontend-user-account) for mandatory path
exclusions and the request-scoped `account.sections` contribution contract.
