// SPDX-License-Identifier: MIT

import type { RevisionKind, RevisionSource } from "./revisions.js";

export type ContentStatus = "draft" | "scheduled" | "published" | "private" | "archived";

export interface ContentLiveSnapshot {
  title: string;
  slug: string;
  excerpt: string | null;
  blocks: BlockDocument;
  fields: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

export interface ContentItem {
  id: string;
  siteId: string;
  type: string;
  status: ContentStatus;
  slug: string;
  title: string;
  excerpt?: string | null;
  blocks: BlockDocument;
  fields: Record<string, unknown>;
  authorId?: string | null;
  publishOn?: string | null;
  unpublishOn?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  locale?: string;
  translationGroupId?: string | null;
  hasWorkingRevision?: boolean;
  workingRevisionId?: string | null;
  workingSource?: RevisionSource | null;
  workingUpdatedAt?: string | null;
  workingUpdatedBy?: string | null;
  liveChangedSinceWorking?: boolean;
  live?: ContentLiveSnapshot | null;
}

export interface BlockDocument {
  version: 1;
  blocks: BlockNode[];
}

export interface BlockNode {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
  children?: BlockNode[];
}

export interface CreateContentInput {
  siteId: string;
  type?: string;
  title: string;
  slug?: string;
  excerpt?: string;
  blocks?: BlockDocument;
  fields?: Record<string, unknown>;
  authorId?: string;
  locale?: string;
  translationGroupId?: string;
}

export interface UpdateContentInput {
  title?: string;
  slug?: string;
  excerpt?: string | null;
  blocks?: BlockDocument;
  fields?: Record<string, unknown>;
  status?: ContentStatus;
  expectedVersion?: number;
  source?: RevisionSource;
  actorId?: string;
}

export interface ContentQuery {
  siteId: string;
  type?: string;
  status?: ContentStatus;
  slug?: string;
  authorId?: string;
  limit?: number;
  cursor?: string;
}

export interface ContentPage {
  items: ContentItem[];
  nextCursor?: string;
  total?: number;
}

export interface ContentRevision {
  id: string;
  contentId: string;
  siteId: string;
  title: string;
  slug: string;
  excerpt: string | null;
  locale: string | null;
  translationGroupId: string | null;
  blocks: BlockDocument;
  fields: Record<string, unknown>;
  version: number;
  baseVersion: number;
  kind: RevisionKind;
  source: RevisionSource;
  createdAt: string;
  createdBy?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface PublishContentInput {
  expectedVersion?: number;
  actorId?: string;
}
