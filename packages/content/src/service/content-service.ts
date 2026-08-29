// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { HooksRegistry } from "@justflows/core";
import { slugify, uniqueSlug } from "./slugify.js";
import type {
  ContentItem,
  ContentLiveSnapshot,
  ContentRevision,
  CreateContentInput,
  UpdateContentInput,
  ContentQuery,
  ContentPage,
  BlockDocument,
  PublishContentInput,
} from "./types.js";
import {
  DEFAULT_REVISION_MAX_HISTORY,
  diffSnapshots,
  selectHistoricalIdsToPrune,
  snapshotsEqual,
  type ContentSnapshot,
  type RevisionDiff,
  type RevisionSource,
} from "./revisions.js";

const EMPTY_BLOCKS: BlockDocument = { version: 1, blocks: [] };

function snapshotOf(item: Pick<ContentItem, "title" | "slug" | "excerpt" | "blocks" | "fields">): ContentSnapshot {
  return {
    title: item.title,
    slug: item.slug,
    excerpt: item.excerpt ?? null,
    blocks: item.blocks,
    fields: item.fields,
  };
}

function liveSnapshotOf(item: ContentItem): ContentLiveSnapshot {
  return {
    ...snapshotOf(item),
    version: item.version,
    updatedAt: item.updatedAt,
  };
}

function stamp(): string {
  return new Date().toISOString();
}

/**
 * Framework-neutral content store with working revisions.
 *
 * Unpublished items live only on the content row. Published items keep that
 * row as the canonical live snapshot; saves write a single working revision
 * until an explicit publish copies it onto the live row.
 */
export class ContentService {
  private readonly items = new Map<string, ContentItem>();
  private readonly revisions = new Map<string, ContentRevision[]>();
  private readonly siteExistingSlugs = new Map<string, Map<string, Set<string>>>();
  private maxHistory = DEFAULT_REVISION_MAX_HISTORY;

  constructor(private readonly hooks: HooksRegistry) {}

  setMaxHistory(max: number): void {
    this.maxHistory = max;
  }

  async create(input: CreateContentInput): Promise<ContentItem> {
    await this.hooks.dispatchGate("content.beforeCreate", { input }, { siteId: input.siteId });

    const type = input.type ?? "post";
    const baseSlug = input.slug ? input.slug : slugify(input.title);
    const slug = uniqueSlug(baseSlug, this.slugsFor(input.siteId, type));
    this.slugsFor(input.siteId, type).add(slug);

    const now = stamp();
    const item: ContentItem = {
      id: randomUUID(),
      siteId: input.siteId,
      type,
      status: "draft",
      slug,
      title: input.title,
      excerpt: input.excerpt ?? null,
      blocks: input.blocks ?? EMPTY_BLOCKS,
      fields: input.fields ?? {},
      authorId: input.authorId ?? null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      locale: input.locale ?? "en-US",
      translationGroupId: input.translationGroupId ?? null,
      hasWorkingRevision: false,
      live: null,
    };

    this.items.set(item.id, item);
    await this.hooks.dispatchAction(
      "content.created",
      {
        contentId: item.id,
        siteId: item.siteId,
        type: item.type,
        translationGroupId: item.translationGroupId ?? item.id,
      },
      { siteId: item.siteId },
    );
    return item;
  }

  async get(id: string): Promise<ContentItem | undefined> {
    const item = this.items.get(id);
    if (!item) return undefined;
    return this.withWorkingOverlay(item);
  }

  async find(query: ContentQuery): Promise<ContentPage> {
    let results = Array.from(this.items.values()).filter(
      (i) =>
        i.siteId === query.siteId &&
        (query.type == null || i.type === query.type) &&
        (query.status == null || i.status === query.status) &&
        (query.slug == null || i.slug === query.slug) &&
        (query.authorId == null || i.authorId === query.authorId),
    );

    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const limit = query.limit ?? 20;
    let start = 0;
    if (query.cursor) {
      const idx = results.findIndex((i) => i.id === query.cursor);
      if (idx >= 0) start = idx + 1;
    }

    const page = results.slice(start, start + limit).map((item) => this.listItem(item));
    const nextId = page.length === limit ? page[page.length - 1]?.id : undefined;

    if (nextId) {
      return { items: page, nextCursor: nextId, total: results.length };
    }
    return { items: page, total: results.length };
  }

  async update(id: string, patch: UpdateContentInput): Promise<ContentItem> {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError(`Content "${id}" not found`);

    if (patch.expectedVersion != null && patch.expectedVersion !== item.version) {
      throw new ConflictError(
        `Version conflict: expected ${patch.expectedVersion}, got ${item.version}`,
      );
    }

    if (patch.status === "published" && item.status !== "published") {
      await this.applyUnpublishedPatch(item, patch);
      return this.publish(id, {
        expectedVersion: item.version + 1,
        ...(patch.actorId ? { actorId: patch.actorId } : {}),
      });
    }

    if (item.status === "published" && patch.status === "draft") {
      return this.unpublish(id, patch);
    }

    if (item.status === "published") {
      return this.saveWorking(item, patch);
    }

    await this.applyUnpublishedPatch(item, patch);
    const updated = this.items.get(id)!;
    await this.hooks.dispatchAction(
      "content.updated",
      { contentId: id, siteId: item.siteId },
      { siteId: item.siteId },
    );
    return updated;
  }

  async publish(id: string, input: PublishContentInput = {}): Promise<ContentItem> {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError(`Content "${id}" not found`);

    if (input.expectedVersion != null && input.expectedVersion !== item.version) {
      throw new ConflictError(
        `Version conflict: expected ${input.expectedVersion}, got ${item.version}`,
      );
    }

    const working = this.workingOf(item.id);
    if (item.status === "published" && working && working.baseVersion !== item.version) {
      throw new ConflictError(
        `Live version changed since this draft was created (live ${item.version}, draft base ${working.baseVersion})`,
      );
    }

    const proposed = working ? snapshotOf(working) : snapshotOf(item);
    const siteId = item.siteId;
    const hookCtx = { siteId };
    const contentRef = {
      contentId: id,
      siteId,
      revision: proposed,
      revisionId: working?.id,
    };

    await this.hooks.dispatchGate("content.beforeUpdate", contentRef, hookCtx);
    await this.hooks.dispatchGate("content.beforePublish", contentRef, hookCtx);

    const now = stamp();
    this.snapshotHistorical(item, input.actorId);
    if (working) this.pushHistoricalIfChanged(item, snapshotOf(working), input.actorId);

    const nextSlug = this.takeSlug(item, proposed.slug);
    const updated: ContentItem = {
      ...item,
      title: proposed.title,
      slug: nextSlug,
      excerpt: proposed.excerpt,
      blocks: proposed.blocks,
      fields: proposed.fields,
      status: "published",
      publishedAt: item.publishedAt ?? now,
      updatedAt: now,
      version: item.version + 1,
      hasWorkingRevision: false,
      workingRevisionId: null,
      live: null,
    };

    this.items.set(id, updated);
    this.removeKind(id, "working");
    this.pruneHistorical(id);

    await this.hooks.dispatchAction("content.updated", { contentId: id, siteId, type: item.type }, hookCtx);
    await this.hooks.dispatchAction("content.published", { contentId: id, siteId, type: item.type }, hookCtx);
    return updated;
  }

  async unpublish(id: string, patch: UpdateContentInput = {}): Promise<ContentItem> {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError(`Content "${id}" not found`);

    const working = this.workingOf(item.id);
    const source = working ? snapshotOf(working) : snapshotOf(item);
    const now = stamp();
    const updated: ContentItem = {
      ...item,
      title: patch.title ?? source.title,
      slug: this.takeSlug(item, patch.slug ?? source.slug),
      excerpt: patch.excerpt !== undefined ? patch.excerpt : source.excerpt,
      blocks: patch.blocks ?? source.blocks,
      fields: patch.fields != null ? { ...source.fields, ...patch.fields } : source.fields,
      status: "draft",
      updatedAt: now,
      version: item.version + 1,
      hasWorkingRevision: false,
      workingRevisionId: null,
      live: null,
    };

    this.items.set(id, updated);
    this.removeKind(id, "working");
    await this.hooks.dispatchAction(
      "content.unpublished",
      { contentId: id, siteId: item.siteId },
      { siteId: item.siteId },
    );
    return updated;
  }

  async discardWorking(id: string, actorId?: string): Promise<ContentItem> {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError(`Content "${id}" not found`);
    const working = this.workingOf(id);
    if (!working) return this.withWorkingOverlay(item);

    this.pushHistoricalIfChanged(item, snapshotOf(working), actorId);
    this.removeKind(id, "working");
    await this.hooks.dispatchAction(
      "content.revisionDiscarded",
      { contentId: id, siteId: item.siteId, revisionId: working.id, actorId },
      { siteId: item.siteId },
    );
    return this.withWorkingOverlay(item);
  }

  async delete(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new NotFoundError(`Content "${id}" not found`);

    const groupId = item.translationGroupId ?? item.id;
    const lastInTranslationGroup = ![...this.items.values()].some(
      (other) =>
        other.id !== id &&
        other.siteId === item.siteId &&
        (other.translationGroupId ?? other.id) === groupId,
    );

    await this.hooks.dispatchGate(
      "content.beforeDelete",
      { contentId: id, siteId: item.siteId, type: item.type, translationGroupId: groupId },
      { siteId: item.siteId },
    );
    this.items.delete(id);
    this.revisions.delete(id);
    this.slugsFor(item.siteId, item.type).delete(item.slug);
    await this.hooks.dispatchAction(
      "content.deleted",
      {
        contentId: id,
        siteId: item.siteId,
        type: item.type,
        translationGroupId: groupId,
        lastInTranslationGroup,
      },
      { siteId: item.siteId },
    );
  }

  async getRevisions(contentId: string): Promise<ContentRevision[]> {
    return [...(this.revisions.get(contentId) ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async getWorkingRevision(contentId: string): Promise<ContentRevision | undefined> {
    return this.workingOf(contentId);
  }

  async compare(contentId: string): Promise<RevisionDiff> {
    const item = this.items.get(contentId);
    if (!item) throw new NotFoundError(`Content "${contentId}" not found`);
    const working = this.workingOf(contentId);
    if (!working) return { changed: false, entries: [] };
    return diffSnapshots(snapshotOf(item), snapshotOf(working));
  }

  async restoreRevision(contentId: string, revisionId: string, actorId?: string): Promise<ContentItem> {
    const item = this.items.get(contentId);
    if (!item) throw new NotFoundError(`Content "${contentId}" not found`);
    const revs = this.revisions.get(contentId) ?? [];
    const rev = revs.find((r) => r.id === revisionId);
    if (!rev) throw new NotFoundError(`Revision "${revisionId}" not found`);

    if (item.status === "published") {
      const restored = await this.saveWorking(item, {
        title: rev.title,
        slug: rev.slug,
        excerpt: rev.excerpt,
        blocks: rev.blocks,
        fields: rev.fields,
        source: "manual",
        ...(actorId ? { actorId } : {}),
      });
      await this.hooks.dispatchAction(
        "content.revisionRestored",
        { contentId, siteId: item.siteId, revisionId, actorId },
        { siteId: item.siteId },
      );
      return restored;
    }

    return this.update(contentId, {
      title: rev.title,
      slug: rev.slug,
      excerpt: rev.excerpt,
      blocks: rev.blocks,
      fields: rev.fields,
      ...(actorId ? { actorId } : {}),
    });
  }

  private async saveWorking(item: ContentItem, patch: UpdateContentInput): Promise<ContentItem> {
    const existing = this.workingOf(item.id);
    const base = existing ? snapshotOf(existing) : snapshotOf(item);
    let proposed: ContentSnapshot = {
      title: patch.title ?? base.title,
      slug: patch.slug ?? base.slug,
      excerpt: patch.excerpt !== undefined ? patch.excerpt : base.excerpt,
      blocks: patch.blocks ?? base.blocks,
      fields: patch.fields != null ? { ...base.fields, ...patch.fields } : base.fields,
    };

    proposed = (await this.hooks.applyFilter(
      "content.revision",
      proposed,
      { siteId: item.siteId, contentId: item.id },
      { siteId: item.siteId },
    )) as ContentSnapshot;

    const now = stamp();
    const source: RevisionSource = patch.source ?? "manual";
    const revision: ContentRevision = {
      id: existing?.id ?? randomUUID(),
      contentId: item.id,
      siteId: item.siteId,
      title: proposed.title,
      slug: proposed.slug,
      excerpt: proposed.excerpt,
      locale: item.locale ?? "en-US",
      translationGroupId: item.translationGroupId ?? null,
      blocks: proposed.blocks,
      fields: proposed.fields,
      version: (existing?.version ?? 0) + 1,
      baseVersion: item.version,
      kind: "working",
      source,
      createdAt: existing?.createdAt ?? now,
      createdBy: existing?.createdBy ?? patch.actorId ?? null,
      updatedAt: now,
      updatedBy: patch.actorId ?? existing?.updatedBy ?? null,
    };

    if (existing) {
      this.pushHistoricalIfChanged(item, snapshotOf(existing), patch.actorId);
    } else {
      this.pushHistoricalIfChanged(item, snapshotOf(item), patch.actorId);
    }

    const withoutWorking = (this.revisions.get(item.id) ?? []).filter((r) => r.kind !== "working");
    if (!snapshotsEqual(snapshotOf(item), proposed)) {
      withoutWorking.unshift(revision);
    }
    this.revisions.set(item.id, withoutWorking);

    await this.hooks.dispatchAction(
      "content.revisionSaved",
      {
        contentId: item.id,
        siteId: item.siteId,
        revisionId: revision.id,
        source,
      },
      { siteId: item.siteId },
    );

    return this.withWorkingOverlay(item);
  }

  private async applyUnpublishedPatch(item: ContentItem, patch: UpdateContentInput): Promise<void> {
    await this.hooks.dispatchGate(
      "content.beforeUpdate",
      { contentId: item.id, siteId: item.siteId, revision: snapshotOf(item) },
      { siteId: item.siteId },
    );

    const updated: ContentItem = {
      ...item,
      title: patch.title ?? item.title,
      excerpt: patch.excerpt !== undefined ? patch.excerpt : item.excerpt ?? null,
      blocks: patch.blocks ?? item.blocks,
      fields: patch.fields != null ? { ...item.fields, ...patch.fields } : item.fields,
      status: patch.status === "published" ? item.status : (patch.status ?? item.status),
      updatedAt: stamp(),
      version: item.version + 1,
    };

    if (patch.slug && patch.slug !== item.slug) {
      updated.slug = this.takeSlug(item, patch.slug);
    }

    if (!snapshotsEqual(snapshotOf(item), snapshotOf(updated))) {
      this.pushHistoricalIfChanged(item, snapshotOf(item), patch.actorId);
    }

    this.items.set(item.id, updated);
  }

  private withWorkingOverlay(item: ContentItem): ContentItem {
    const working = this.workingOf(item.id);
    if (!working || item.status !== "published") {
      return {
        ...item,
        hasWorkingRevision: false,
        workingRevisionId: null,
        live: null,
        liveChangedSinceWorking: false,
      };
    }
    return {
      ...item,
      title: working.title,
      slug: working.slug,
      excerpt: working.excerpt,
      blocks: working.blocks,
      fields: working.fields,
      updatedAt: working.updatedAt,
      hasWorkingRevision: true,
      workingRevisionId: working.id,
      workingSource: working.source,
      workingUpdatedAt: working.updatedAt,
      workingUpdatedBy: working.updatedBy ?? null,
      liveChangedSinceWorking: working.baseVersion !== item.version,
      live: liveSnapshotOf(item),
    };
  }

  private listItem(item: ContentItem): ContentItem {
    const working = this.workingOf(item.id);
    return {
      ...item,
      hasWorkingRevision: item.status === "published" && Boolean(working),
      workingRevisionId: working?.id ?? null,
      workingUpdatedAt: working?.updatedAt ?? null,
    };
  }

  private workingOf(contentId: string): ContentRevision | undefined {
    return (this.revisions.get(contentId) ?? []).find((r) => r.kind === "working");
  }

  private pushHistoricalIfChanged(
    item: ContentItem,
    snap: ContentSnapshot,
    actorId?: string,
  ): void {
    const newest = (this.revisions.get(item.id) ?? [])
      .filter((r) => r.kind === "historical")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (newest && snapshotsEqual(snapshotOf(newest), snap)) return;

    const now = stamp();
    const rev: ContentRevision = {
      id: randomUUID(),
      contentId: item.id,
      siteId: item.siteId,
      title: snap.title,
      slug: snap.slug,
      excerpt: snap.excerpt ?? null,
      locale: item.locale ?? "en-US",
      translationGroupId: item.translationGroupId ?? null,
      blocks: snap.blocks,
      fields: snap.fields,
      version: item.version,
      baseVersion: item.version,
      kind: "historical",
      source: "manual",
      createdAt: now,
      createdBy: actorId ?? null,
      updatedAt: now,
      updatedBy: actorId ?? null,
    };
    const list = this.revisions.get(item.id) ?? [];
    list.unshift(rev);
    this.revisions.set(item.id, list);
    this.pruneHistorical(item.id);
  }

  private snapshotHistorical(item: ContentItem, actorId?: string): void {
    this.pushHistoricalIfChanged(item, snapshotOf(item), actorId);
  }

  private removeKind(contentId: string, kind: ContentRevision["kind"]): void {
    const list = this.revisions.get(contentId) ?? [];
    this.revisions.set(
      contentId,
      list.filter((r) => r.kind !== kind),
    );
  }

  private pruneHistorical(contentId: string): void {
    const list = this.revisions.get(contentId) ?? [];
    const historical = list.filter((r) => r.kind === "historical");
    const drop = new Set(selectHistoricalIdsToPrune(historical, this.maxHistory));
    if (drop.size === 0) return;
    this.revisions.set(
      contentId,
      list.filter((r) => r.kind !== "historical" || !drop.has(r.id)),
    );
  }

  private takeSlug(item: ContentItem, next: string): string {
    if (next === item.slug) return item.slug;
    const slugSet = this.slugsFor(item.siteId, item.type);
    slugSet.delete(item.slug);
    const unique = uniqueSlug(next, slugSet);
    slugSet.add(unique);
    return unique;
  }

  private slugsFor(siteId: string, type: string): Set<string> {
    let byType = this.siteExistingSlugs.get(siteId);
    if (!byType) {
      byType = new Map();
      this.siteExistingSlugs.set(siteId, byType);
    }
    let set = byType.get(type);
    if (!set) {
      set = new Set();
      byType.set(type, set);
    }
    return set;
  }
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(message: string) { super(message); this.name = "NotFoundError"; }
}

export class ConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message: string) { super(message); this.name = "ConflictError"; }
}
