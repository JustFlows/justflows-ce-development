# Frontend account pages

The built-in `account` content type owns the site's frontend user account.
Its default **Your account** page starts at `/account` and is edited through
Content → Account with the normal page builder. It uses the site's theme,
header, footer, styles, and page/template settings. Theme template selection checks
`account-<slug>`, `account`, `page-<slug>`, and `page` before generic fallbacks,
so the default uses the editable page canvas without a duplicate post title/date.

## Customize the page

Change headings and text, add normal layout blocks, adjust spacing and CSS,
and move, remove or add **Account section** blocks. Each account block can show:

- **Account controls:** sign out and action feedback.
- **Profile:** the current user's profile section.
- **Plugin sections:** all active contributions, or one stable section ID such
  as `justflows.shop.orders`.
- **Workspaces:** owned workspaces on the installation's root site.
- **All account sections:** the complete set together.

Section titles can be hidden so an editable heading block supplies your own
wording. Empty or unavailable sections produce no empty panel. Placing a section
twice does not duplicate its interactive DOM identities.

The content record stores only layout and configuration. Account data comes from
the authenticated request, core services and `account.sections`, and is never
saved into the page's blocks or fields. Builder block previews show a placeholder;
the signed-in frontend preview hydrates the account data.

Additional `account` pages use the same privacy rules. The current published
primary page determines login links; renaming its slug updates those links.
`/account` remains an entry point, `/platform-account` remains a compatibility
redirect, and recorded prior permalinks redirect privately to the new URL.
Draft pages require the normal authorized preview flow.

## Privacy is part of the content type

The `account` type always requires an authenticated site session. Publishing a
page makes its layout available to signed-in users; it does not make it public.
Page fields, themes and plugin settings cannot disable this policy.

Account pages, prior URLs and pagination are classified before static-file,
object-storage export or shared page-cache serving. They send `private, no-store`
for browser caches, `no-store` for CDN/surrogate caches, and `noindex, nofollow`.
Core and SDK cache facades bypass reads, writes and shared in-flight deduplication
inside private rendering, while invalidation still reaches the shared cache.
Normal public requests retain caching.

Account content is excluded from public content APIs (including preview queries),
public search results and external search indexing, sitemaps, public permalink
archives, and static-export discovery/crawling. Type-derived exclusions also feed
exported hosting fallbacks and PWA navigation bypasses. An account page cannot
serve as the site's public home page. Private account responses do not inject
core analytics markup.

Account API endpoints retain their separate mandatory path exclusions, including
neutral `/api/<namespace>/account` and legacy extension aliases. Each provider
must still validate current-user ownership when reading or changing its data.
See [the hook contract](HOOKS.md#frontend-user-account).

External caches configured to ignore origin policy need matching bypass rules.
Purge any old copies when deploying a privacy-policy change; the host cannot
control an independently configured proxy or a plugin's custom external cache.

## Installation and upgrades

Fresh installations and workspace sites seed the default layout in their default
locale. Migration `0045_account_pages` backfills existing PostgreSQL, MySQL and
MariaDB databases. Control databases do not seed layouts belonging to separate
connections; each local database receives its own account page.

Seeding preserves existing account layouts, renamed pages, drafts and trashed
pages. It does not overwrite customization or republish a page the administrator
removed. The `account` type is reserved for core and cannot be deleted or weakened
as an ordinary custom type.

## Content-type cache settings

Admin → Content Types exposes **Cache-Control** for cacheable types: inherit the site default, never cache (`private, no-store`), or a validated custom header. The core `account` type has no override control; API attempts to change its policy are rejected.

Policies follow canonical URLs, old aliases, locale URLs and pagination. Private, no-cache, no-store and zero-freshness policies bypass shared caches and deployed static pages, and are excluded from new exports. Positive public freshness caps the internal page-cache TTL. Saving a policy clears page/content caches and requests a configured CDN purge even when automatic revalidation is disabled. Existing browser copies and externally hosted exports require expiry or redeployment; response headers cannot recall copies already downloaded.

Individual posts and pages expose the same control under **Advanced**. Their `fields.cacheControl` value follows drafts, autosaves, revisions and translations; null inherits the content type. The precedence is mandatory core privacy → post override → content type → site default. Published posts keep their live policy until the draft is published. Account records have no override control. No additional database migration is needed.
