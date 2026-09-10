// SPDX-License-Identifier: MIT
/** Search backends receive public text only; no fields, revisions, or credentials. */
export interface SearchDocument {
  id: string;
  siteId: string;
  locale: string;
  type: string;
  title: string;
  slug: string;
  summary: string;
  body: string;
}
/** Optional external candidate engine. The host always rechecks live visibility. */
export interface SearchBackend {
  id: string;
  typoTolerance?: boolean;
  search(query: { siteId: string; q: string; locale: string; limit: number }): Promise<string[]>;
  upsert(document: SearchDocument): Promise<void>;
  remove(id: string, siteId: string): Promise<void>;
}
