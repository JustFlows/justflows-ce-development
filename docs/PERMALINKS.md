# Permalinks

Administrators configure public URLs under **Settings → Permalinks**. Existing
sites default to `/%postname%/` without a trailing slash, retaining their current
URLs. Settings are stored in the existing site settings table; no migration is
required. PostgreSQL, MySQL, and MariaDB use the same settings contract.

## Structures and tokens

Post presets are Plain (`/?p=%id%`), Day and name
(`/%year%/%monthnum%/%day%/%postname%/`), Month and name
(`/%year%/%monthnum%/%postname%/`), Post name (`/%postname%/`), and Numeric / ID
(`/archives/%id%/`). Justflows content IDs are UUIDs, so the Plain and Numeric / ID
presets contain UUIDs, not WordPress integer IDs.

Custom structures must start with `/`, include `%postname%` or `%id%`, and use
only the documented tokens and literal path segments. Query strings are only
supported by the Plain preset. Unknown tokens, traversal, repeated separators,
fragments, and reserved platform paths are rejected.

| Token                           | Value                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `%postname%`                    | Content slug                                                                                          |
| `%id%`                          | Content UUID                                                                                          |
| `%year%`, `%monthnum%`, `%day%` | UTC publication date; creation date for an unpublished preview                                        |
| `%category%`                    | First assigned term slug in the `category` taxonomy, ordered by slug then ID; `uncategorized` if none |
| `%author%`                      | Author ID; `unknown` if none                                                                          |
| `%type%`                        | Registered content type slug                                                                          |

For example, `/%type%/%category%/%postname%/` gives
`/post/news/launch/`. Republishing an existing post preserves its original
publication date, so editing a post does not move a date-based URL.

A per-type base such as `shop/products` gives product URLs like
`/shop/products/ceramic-mug`. Without a base, pages and custom types retain their
root-level slug. Type bases override the general post structure when supplied
through the API. Bases have no leading or trailing slash.

Category and tag bases default to `category` and `tag`. Registered custom
taxonomies can have their own bases. Archive pages list published content
assigned through the existing `terms` and `content_terms` tables. This screen
configures URLs; term creation and assignment remain the responsibility of the
extension that manages that taxonomy.

## Locales and trailing slashes

The locale prefix precedes the configured structure. The default locale is
unprefixed; other active locales use their exact locale tag, for example
`/nl-NL/2026/09/07/lancering/`. Explicit default-locale prefixes and alternate
casing redirect to the canonical URL. The configured homepage stays at the
locale root. A trailing-slash policy applies to content URLs, archives, and
locale roots; `/` itself is always `/`.

Content-linked menus select the published translation when available. If none
exists, they use the original content's canonical locale URL. Handwritten menu
URLs are still handled by the existing menu localization rules. Authenticated
previews retain their access checks and bypass public HTML caching.

## Redirects and collisions

Saving a new structure or base records known previous published URLs and returns
301 redirects directly to their current URLs. History stores content IDs, so
successive settings changes do not create redirect chains. Taxonomy history
stores the locale and term ID. Draft URLs are not added to public history;
deleted or unpublished targets are not served by historical redirects.

The admin screen shows a warning before saving and lists historical content
URLs afterward. Imported WordPress URLs, already ambiguous URLs shared by
multiple content types, handwritten links, deleted items, and URLs from before
history was recorded cannot be mapped automatically. Review these separately.
The permalink history is available through the settings API for a future
Redirect manager; it is not a general-purpose manual redirect editor.

The server rejects collisions with known content URLs, archive URLs, historical
URLs, enabled locale prefixes, and reserved platform routes, including the
configured admin path. New content and publication resolve conflicting slugs
with suffixes such as `-2`, including collisions between different content types.
A reserved path is rejected instead of claiming a platform route. Existing
ambiguous URLs do not generate an arbitrary redirect when their structures are
separated.

Saving settings invalidates cached public pages, menus, content, and site
context. Core sitemap entries, canonical tags, blog links, translated links,
content-linked menu URLs, and REST content `links.self` use the active structure.
Explicit SEO canonical overrides and handwritten URLs remain author controlled.

## Settings API

`GET /api/settings/permalinks` and `PUT /api/settings/permalinks` require an
administrator session. Writes use the normal CSRF protection. The PUT body is:

```json
{
  "structure": "/%year%/%monthnum%/%postname%/",
  "typeBases": { "product": "shop/products" },
  "categoryBase": "topics",
  "tagBase": "tag",
  "taxonomyBases": {},
  "trailingSlash": "always"
}
```

GET also returns the presets, registered types and taxonomies, and historical
redirects. PUT returns `{ "ok": true, "redirectsCreated": 3 }`; the count covers
newly recorded content paths. Invalid input returns 400; URL conflicts return 409. Public REST content responses include `links.self`, a site-relative
canonical permalink. Extensions should consume that link rather than assemble
URLs from slugs.

Static export requires a path-based preset. Plain query-string identities cannot
be represented by separate static files, so export rejects that configuration
with an actionable error.

## Local verification

1. Create published posts, a page, and a custom-type item. Note their URLs.
2. Select Day and name, give the custom type a base, and enable trailing slashes.
3. Check the new URLs, sitemap, canonical tags, blog links, and REST `links.self`.
4. Request the noted old URLs: each should return a 301 to its current URL.
5. Change the structure again and verify the oldest URLs redirect directly.
6. Check a translated item, a locale root, and an authenticated draft preview.
7. Try `api`, the configured admin path, and an enabled locale as a base. Saving
   must fail without changing the active settings.
8. Check taxonomy archives if extensions have assigned terms. Change their bases
   and verify the old archive URLs redirect.
