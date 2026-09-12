# Cache (jf-cache)

Justflows ships with a built-in object cache — **jf-cache** — so hot paths can
avoid hitting the database on every request. The idea is similar to Next.js data
caching: store the result of an expensive read, reuse it for a while, and throw
it away when the underlying data changes.

No Redis is required for a basic install. Memory or filesystem is enough for
single-node hosting (Plesk, cPanel, one VPS).

---

## Turn it on or off

**Admin UI:** **Tools → Performance suite** — configure object cache, GZIP, and browser cache;
save once and the app restarts automatically (via `tmp/restart.txt` on Plesk/Passenger).

Or add these to `.env` manually (see also `.env.example`):

| Variable            | Default                                     | Purpose                                                         |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `CACHE_ENABLED`     | Fresh install: `0`. Fallback if unset: off. | Global kill switch. Use `0`, `false`, or `off` to disable.      |
| `CACHE_DRIVER`      | `filesystem`                                | `memory`, `filesystem`, or `redis` (redis not implemented yet). |
| `CACHE_TTL_SECONDS` | `300`                                       | Default TTL for cached entries (seconds).                       |
| `CACHE_DIR`         | `./.cache` under JF_ROOT                    | Directory for the filesystem driver.                            |
| `CACHE_REDIS_URL`   | —                                           | Reserved for a future Redis driver.                             |

When caching is **disabled**, every read goes straight to the source — same
behaviour as a cold cache, but without storing anything. Useful while debugging
or when you suspect stale data.

```env
# Disable caching entirely
CACHE_ENABLED=0
```

```env
# Single-node production — survives process restarts without Redis
CACHE_DRIVER=filesystem
CACHE_TTL_SECONDS=600
CACHE_DIR=./.cache
```

Restart the Node.js app after changing cache env vars. The cache singleton is
created once per process.

---

## What is cached today

jf-cache uses several layers on the public site:

| Key prefix                | What                                                                          | TTL                 | Invalidated when                                     |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| `page:html:`              | **Full rendered HTML** for public pages                                       | `CACHE_TTL_SECONDS` | Content, theme, menu, settings, CSS provider changes |
| `content:`                | Published pages/posts by slug, translation alternates, paginated blog queries | `CACHE_TTL_SECONDS` | Content updated or deleted                           |
| `theme:mods:`             | Active theme customization                                                    | `CACHE_TTL_SECONDS` | Theme/design save                                    |
| `menus:`                  | Navigation menus                                                              | `CACHE_TTL_SECONDS` | Menu edits                                           |
| `css:provider:`           | Active CSS framework assets list                                              | `CACHE_TTL_SECONDS` | CSS provider activate/delete                         |
| `security-headers:config` | Security header policy                                                        | 30s (5s on error)   | Security settings saved                              |

Preview mode (`?preview` / logged-in editor) **bypasses** page and layout cache.

---

## Observability

### Response headers (public pages)

Every public HTML response can include:

```http
X-Jf-Cache: hits=3; misses=1; sets=1
X-Jf-Page-Cache: HIT
```

- **`X-Jf-Cache`** — summary of all cache operations during that request
- **`X-Jf-Page-Cache`** — `HIT`, `MISS`, or `BYPASS` for the full-page HTML layer

Check in browser DevTools → Network → select a page request → Response headers.

### Admin Tools → stats panel

**Tools → Object cache** shows process-lifetime hits/misses, hit rate, key count, and sample filenames.

`GET /api/cache/stats` returns the same data for administrators.

### Debug logging

With `LOG_LEVEL=debug`, each cache operation logs to the server console:

```
[jf-cache] HIT page:html:/about:
[jf-cache] MISS content:published:about:
```

### Site Health

**Admin → Health** includes an **Object cache** check (enabled state, key count, hit rate).

---

## Clear the cache

**Tools page:** **Clear cache now** (does not require a restart).

**Admin API** (requires administrator role):

```http
POST /api/cache/clear
```

**CLI** (authenticated against your running site):

```bash
justflows cache clear
```

Both call the same handler: wipe all cached entries and return `{ ok: true, enabled, clearedAt }`.

If you only changed content, you usually do not need to clear manually — content
routes already invalidate the `content:` prefix on save and delete.

---

## The API

Server code uses the shared singleton:

```ts
import { getJfCache } from "../lib/jf-cache.js";

const cache = getJfCache();
```

The `@justflows/cache` package provides the underlying types and factory. Plugins
or standalone scripts can use `createJfCache()` from that package directly if
they need their own instance.

### `remember(key, ttlSeconds, fn)` — preferred

Read-through cache with **in-flight deduplication**. If ten requests miss the
cache at the same time, the fetch function runs once. This is the main pattern
— closest to Next.js `unstable_cache`.

```ts
const menu = await getJfCache().remember(`menus:primary:${siteId}`, 300, () =>
  loadMenuFromDatabase(siteId),
);
```

- **Hit:** returns the stored value, `fn` is not called.
- **Miss:** runs `fn`, stores the result for `ttlSeconds`, returns it.
- **Disabled (`CACHE_ENABLED=0`):** always runs `fn`, never stores.

### Low-level methods

| Method                         | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `get(key)`                     | Read one entry. Returns `undefined` on miss or when disabled. |
| `set(key, value, ttlSeconds?)` | Write one entry. No-op when disabled.                         |
| `delete(key)`                  | Remove one key (and any in-flight promise for it).            |
| `invalidate(prefix)`           | Remove all keys starting with `prefix`.                       |
| `clear()`                      | Remove everything.                                            |

Use **`invalidate(prefix)`** when a whole category of data changes:

```ts
await getJfCache().invalidate("content:");
await getJfCache().invalidate("menus:");
```

Use **`delete(key)`** when you know the exact key:

```ts
await getJfCache().delete("security-headers:config");
```

---

## Key naming

Use a consistent prefix so invalidation stays simple:

```
{domain}:{variant}:{id...}
```

Examples:

```
content:published:about:
content:published:about:nl
content:published-posts:site-abc:nl:10:0
content:alternates:550e8400-e29b-41d4-a716-446655440000
menus:primary:site-abc
theme-mods:justflows.default
security-headers:config
```

Rules of thumb:

- Start with a **namespace** you can wipe (`content:`, `menus:`).
- Include **locale or scope** when the value differs per locale or site.
- Keep keys **stable** — changing the key scheme orphan old entries until TTL
  expires or you call `clear()`.

---

## Adding cache to server code

Typical pattern:

1. Split **fetch** (database/API) from **public function** (cached wrapper).
2. Wrap with `remember()` and a TTL.
3. Call **`invalidate(prefix)`** from the write path (route handler, hook, job).

```ts
import { getJfCache } from "./jf-cache.js";

const PREFIX = "widgets:";

async function fetchFeaturedWidgets(siteId: string) {
  const db = await getDb();
  return db.query("SELECT * FROM widgets WHERE site_id = ? AND featured = 1", [siteId]);
}

export async function getFeaturedWidgets(siteId: string) {
  return getJfCache().remember(`${PREFIX}featured:${siteId}`, 300, () =>
    fetchFeaturedWidgets(siteId),
  );
}

export async function invalidateWidgetCache(): Promise<void> {
  await getJfCache().invalidate(PREFIX);
}
```

Then, in the route that saves widgets:

```ts
await saveWidget(data);
await invalidateWidgetCache();
```

Choose TTL based on how stale the data can be:

- **Security / auth-related:** short (seconds to minutes), or do not cache.
- **Published content:** `CACHE_TTL_SECONDS` is usually fine; invalidation on
  write is what keeps it correct.
- **Expensive aggregates** (menus, theme mods): minutes; invalidate on save.

---

## Drivers

### Memory

- Fastest.
- Lost on process restart.
- Good for **local development** or when you prefer simplicity over persistence.

### Filesystem (default)

- JSON files under `CACHE_DIR` (default `.cache/` in the app root).
- **Recommended for single-node production** — survives restarts without Redis.
- Not shared across multiple Node processes or machines — use only when you run
  a single instance.

### Redis (planned)

- For multi-instance deployments where every node must see the same cache and
  invalidation.
- Not required for basic installs; selecting `redis` today throws a clear error
  at startup.

---

## Plugins and hooks

### `ctx.cache` — shared jf-cache for plugins

Every plugin gets a namespaced cache on `PluginContext`. Keys are stored under
`plugin:{pluginId}:…` and cannot touch core or other plugins.

```ts
export async function activate(ctx: PluginContext) {
  const products = await ctx.cache.remember("products:list", 120, async () => {
    return fetchProductsFromApi();
  });

  ctx.hooks.action("content.published", async () => {
    await ctx.cache.invalidate("products:");
  });

  ctx.hooks.action("cache.revalidated", (event) => {
    ctx.logger.info("Core cache revalidated", {
      trigger: event.trigger,
      objects: event.objects,
    });
  });
}
```

| Method                   | Purpose                              |
| ------------------------ | ------------------------------------ |
| `remember(key, ttl, fn)` | Read-through with in-flight dedupe   |
| `get` / `set` / `delete` | Direct access                        |
| `invalidate(prefix?)`    | Wipe plugin keys (omit prefix = all) |

When global caching is disabled, `remember` still runs `fn` and writes are no-ops.

### Response headers

Use the existing `http.responseHeaders` filter to adjust `Cache-Control` (or other
headers) for public responses — GZIP itself is core middleware, not plugin-controlled.

### Own instance (optional)

Plugins may still create a private cache with `createJfCache()` from `@justflows/cache`
if they need an isolated driver. Prefer `ctx.cache` for the shared store.

On an action hook (`content.published`, `app.started`), precompute and store.
On a filter (`content.render`), read from cache — see
[Hooks — Synchronous hooks](./HOOKS.md#synchronous-hooks) for render-path constraints.

---

## Debugging stale data

1. Set `CACHE_ENABLED=0` and reproduce. If the bug disappears, it is cache-related.
2. Run `justflows cache clear` or `POST /api/cache/clear`.
3. Confirm the **write path** calls `invalidate()` / revalidation for the right objects.
4. Check TTL — a long TTL without revalidation will show old data until expiry.
5. Check **Tools → Revalidate on update** — if off, updates will not clear cache layers.

---

## Performance suite (GZIP + browser cache)

Beyond object cache, Justflows can compress responses and send browser cache headers.
Configure everything from **Admin → Tools → Performance suite**, or set these in `.env`:

| Variable                          | Default                                     | Purpose                                                       |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `JF_GZIP_ENABLED`                 | Fresh install: `0`. Fallback if unset: off. | GZIP-compress HTML, JSON, CSS, JS when the client accepts it. |
| `JF_GZIP_LEVEL`                   | `6`                                         | Compression level (1 = fast, 9 = smallest).                   |
| `JF_GZIP_MIN_BYTES`               | `1024`                                      | Skip compression below this response size.                    |
| `JF_BROWSER_CACHE_ENABLED`        | Fresh install: `0`. Fallback if unset: off. | Send `Cache-Control` on public HTML and static assets.        |
| `JF_BROWSER_CACHE_HTML_MAX_AGE`   | `60`                                        | `max-age` for public HTML pages (seconds).                    |
| `JF_BROWSER_CACHE_STATIC_MAX_AGE` | `86400`                                     | `max-age` for `/uploads`, `/public`, `/assets` (seconds).     |
| `JF_BROWSER_CACHE_SWR`            | `300`                                       | `stale-while-revalidate` for HTML pages.                      |

### Revalidate on update

| Variable                   | Default                                     | Purpose                                                         |
| -------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| `CACHE_REVALIDATE_ENABLED` | Fresh install: `0`. Fallback if unset: off. | Clear selected layers when content/menus/theme/settings change. |
| `CACHE_REVALIDATE_OBJECTS` | all                                         | Comma list: `pages,content,menus,theme,cssProviders,site`.      |

When a page/post is saved, only **selected** layers that the trigger affects are cleared
(e.g. content updates clear `content` + `pages` if both are selected). Disable to rely
on TTL alone. Emits `cache.revalidated` for plugins.

The static-site exporter's optional auto-rebuild (`STATIC_EXPORT_AUTO=1`) listens
on this same `cache.revalidated` action, so it needs `CACHE_REVALIDATE_ENABLED=1`
to fire. See [Static / edge export](STATIC-EXPORT.md).

Admin and API routes always receive `Cache-Control: no-store`. GZIP adds
`Content-Encoding: gzip` and `Vary: Accept-Encoding` on compressed responses.

Verify in browser DevTools → Network: look for `Content-Encoding: gzip` and
`Cache-Control` on public pages.

---

## Package layout

| Path                              | Role                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `packages/cache/`                 | `@justflows/cache` — adapters, `JfCache`, `createJfCache()` |
| `apps/server/src/lib/jf-cache.ts` | Server singleton wired from `.env`                          |
| `packages/core/src/config/`       | `CacheConfigSchema`, env loading                            |

For a mental model: **`@justflows/cache`** is the library; **`getJfCache()`**
is the one shared instance the running server uses.

## Scheduled transitions

Due publishing and expiry clear content, page and menu caches through the
committed scheduling event. This is mandatory even when optional save-time
revalidation is disabled, so cached pages cannot retain an expired entry until
TTL. Feed plugins invalidate on the actual `content.published` /
`content.unpublished` action. Shared preview responses are always private and
`no-store`. See [Scheduled publishing](SCHEDULING.md).
