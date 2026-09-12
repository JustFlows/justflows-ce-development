# Scheduled publishing

Save a post, page or custom content entry, then use **Publish → Schedule** in its
editor. **Publish on** publishes the latest saved draft at a future instant.
**Unpublish on** is optional and returns the entry to draft. A published entry
can have an expiry without another publish date, or a future date for its
working revision while its current version stays live.

Save editor changes before setting a schedule. Later saved edits become part of
the scheduled draft. Restore a historical revision into the editor to schedule
that revision. A conflicting working revision is not published automatically;
resolve the live-version conflict first. **Cancel schedule** clears both dates,
returns an unpublished scheduled entry to draft, and leaves published content
live. Publishing manually clears the pending publish date and retains expiry;
unpublishing or trashing clears both dates. Discarding a working draft cancels
its scheduled publication but retains the live entry's expiry.

## Timezones and agenda

Datetime controls use the signed-in author's **browser timezone**. The editor
shows that timezone, the site timezone from General settings, and each selected
time formatted in the site timezone. The API requires an ISO 8601 instant with
`Z` or an explicit offset; storage and execution use UTC. Nonexistent local times
at the spring daylight-saving change are rejected. A repeated autumn local time
uses the browser's earlier occurrence; switch the input timezone to **UTC**
(or use the API's explicit offset) when the later occurrence is needed. Switching
the input timezone preserves the selected instant. Changing the site timezone does not move schedules.

Open **Content → Publishing agenda**, or the **Scheduled** filter, to see upcoming
publication and expiry events in time order. The agenda loads all pages of
scheduled results, includes scheduled revisions of published entries, and can
filter by content type and language code. Leave the language empty for all
translations. Access scopes still apply: users restricted to a type or locale
must select that scope. Agenda times use the viewer's browser timezone. Refresh
the agenda to see transitions that have happened since opening it.

## Preview and access

The editor's normal authenticated draft preview supports scheduled content.
**Share draft preview** creates a signed link valid for 24 hours. The link exposes
only that content entry's current saved draft, using public site chrome. It does
not grant access to other drafts, unpublished navigation or theme changes. The
response is private, not cached, excluded from indexing and sends no referrer.
Trashing the entry, changing its content version (including changing its schedule),
expiry of the token, or changing `APP_SECRET` invalidates the link. Working-draft
saves may update what an existing link shows until the live version changes.

Scheduling requires both `content:update` and `content:publish`, evaluated with
the entry's site, type, locale and owner. Preview-link creation requires scoped
`content:read` and `content:update`. Scheduling a translation never publishes its
source or siblings. Each site has separate content and deadlines.

## HTTP contract

Cookie-authenticated administration uses `PUT /api/content/{id}/schedule`.
The federated API exposes `PUT /api/manage/v1/content/{id}/schedule` with the
same owner and API-key scope checks as its other content operations:

```json
{
  "publishOn": "2030-06-01T09:00:00+02:00",
  "unpublishOn": "2030-06-08T18:00:00+02:00",
  "expectedVersion": 3
}
```

Both dates and `expectedVersion` are required. Set both dates to `null` to cancel.
Dates must be future instants, with expiry strictly after publication. The
response is the updated content entry, including nullable `publishOn` and
`unpublishOn`; schedule changes advance `version`. Stale versions return 409,
invalid dates 400, missing content 404, and insufficient access 403. A raw
`PATCH` with `status: "scheduled"` is rejected; use the schedule endpoint.
`GET /api/content?status=scheduled` (and the management equivalent) includes any
entry with a pending publish or expiry date, including live revisions.
`POST /api/content/{id}/preview-link` returns a relative signed preview URL.

## Runtime and recovery

Migration `0030_content_scheduling` adds deadlines to content and a durable
`content_schedule_events` table. PostgreSQL has its own SQL file; MySQL and
MariaDB share the MySQL file. Existing rows remain unscheduled.

`@justflows/jobs` runs `content.publish-scheduled` on startup and every minute
using its 30-second tick. This is minute-level scheduling, not an exact-second
alarm. It processes a bounded batch of 100 due entries per scan; a larger backlog
drains over subsequent scans. Keep the Node application running: sleeping
shared-hosting workers resume processing when the host wakes them. No external
cron service or Redis is required. Transient scan failures retry on the next
minute instead of permanently disabling the recurring job.

Database row locks serialize simultaneous workers. The content snapshot,
revision history, deadline removal, webhook queue entries and durable transition
event commit together. A failed publish gate rolls everything back and leaves
the deadline available for retry. After downtime, due publication and expiry are
caught up. If the entire publication window was missed, the entry goes to draft
without briefly appearing in public feeds or emitting a publication webhook.

Schedule metadata saves emit no publication/unpublication hooks. Actual
transitions emit `content.published` or `content.unpublished` with `contentId`,
`siteId`, `type`, `locale`, `eventId` and `scheduleEventId`, with context source
`job`. Webhook deliveries are queued in the transition transaction. Cache and
plugin actions run from the committed event, clearing content, page and menu
caches even when optional save-time revalidation is disabled. The sitemap reads
the new published state, feed plugins invalidate through the normal content
actions, and static export auto-rebuild hooks run on the actual transition.

Durable event processing is **at least once**: a crash after a hook runs but
before its event is removed can repeat that hook. Use `eventId` to deduplicate
external side effects. Plugin action failures retain the normal hook registry's
failure isolation; plugins remain responsible for retrying their own external
work. Audit actions are `content.schedule_set`, `content.schedule_changed`,
`content.schedule_cancelled` and `content.schedule_executed`.

## Developer verification

Focused tests live in server `lib/__tests__` and `routes/__tests__`, with editor
checks colocated beside `ContentSchedule.tsx`. The opt-in database suite runs the
real new migration against focused fixtures for the existing content/revision
schema and exercises transactions and concurrent workers:

```sh
SCHEDULE_TEST_DATABASE=1 DB_NAME=schedule_test DB_DRIVER=postgres \
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD=local-test-value \
DB_SSL=0 pnpm --filter @justflows/server exec vitest run \
  src/lib/__tests__/content-scheduling-db.integration.test.ts
```

Use a fresh disposable database named `schedule_test`. Repeat with `mysql` and
`mariadb`, their ports and test credentials. This suite does not certify the
older consolidated installation baseline; it verifies the scheduling migration
and runtime against each supported database engine.
