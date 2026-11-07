// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../src/lib/content/visibility-scope.js", () => {
  const open = { restricted: false, allows: () => true, sql: () => ({ sql: "1 = 1", params: [] }) };
  return { getVisibilityScope: async () => open, getAnonymousVisibilityScope: async () => open, isOpenToEveryone: async () => true };
});
vi.mock('../../../src/lib/database/db.js', () => ({ getDb: async () => ({ query: mocks.query }) }));
vi.mock('../../../src/lib/content/content-api.js', () => ({ serializeContentRow: (row: unknown) => row }));
import { queryPublishedContent } from '../../../src/lib/content/content-query.js';
const options = { contentType: 'post', taxonomy: '', term: '', orderBy: 'published', order: 'desc', limit: 6, offset: 0 };
beforeEach(() => { mocks.query.mockReset().mockResolvedValueOnce([{ id: 'one', type: 'post' }]).mockResolvedValueOnce([{ total: 1 }]); });
describe('published content queries', () => {
  it('preserves tenant, locale, published/scheduled/trash and system-type boundaries', async () => {
    await queryPublishedContent('site-one', 'nl', options);
    const [sql, params] = mocks.query.mock.calls[0]!;
    expect(sql).toContain('c.site_id = ? AND c.locale = ?'); expect(sql).toContain("c.status = 'published'");
    expect(sql).toContain('c.trashed_at IS NULL'); expect(sql).toContain('c.published_at <= CURRENT_TIMESTAMP'); expect(sql).toContain("NOT IN ('account', 'auth')");
    expect(params).toEqual(['site-one', 'nl', 'post', 6, 0]); expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it('parameterizes taxonomy/term filters and does not accept sort SQL', async () => {
    await queryPublishedContent('site-one', 'nl', { ...options, taxonomy: 'category', term: "slug' OR 1=1", orderBy: 'title; DROP', order: 'asc; DROP', limit: 10000, offset: -50 });
    const [sql, params] = mocks.query.mock.calls[0]!;
    expect(sql).toContain('t.site_id = c.site_id AND x.site_id = c.site_id'); expect(sql).not.toMatch(/DROP|OR 1=1/);
    expect(params).toEqual(['site-one', 'nl', 'post', 'category', "slug' OR 1=1", 100, 0]);
  });
  it('refuses private system content before touching the database', async () => {
    expect(await queryPublishedContent('site-one', 'nl', { ...options, contentType: 'auth' })).toEqual({ items: [], total: 0 });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('keeps query growth constant as result counts grow', async () => {
    mocks.query.mockReset().mockResolvedValueOnce(Array.from({ length: 40 }, (_, i) => ({ id: String(i), type: 'post' }))).mockResolvedValueOnce([{ total: 40 }]);
    const result = await queryPublishedContent('site-one', 'nl', { ...options, limit: 40 });
    expect(result.items).toHaveLength(40); expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
