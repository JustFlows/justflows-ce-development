# Content visibility

Visibility decides who can view published content. It works the same way for
every content type, and plugins can add rules to it. This page describes SDK
0.1.8 and later.

Visibility is separate from editorial permissions. Being able to edit content
doesn't let you view it on the public site. An administrator browsing the site
gets the same answer as any other user with that role.

## Setting a rule

- **Content type default:** Admin → Content Types → the type → Visibility. It
  applies to every entry of that type. Administrators only.
- **Entry override:** the Visibility panel in the editor. It needs
  `content:update` on the entry, and it's recorded in the audit log.

An override replaces the type default completely. It doesn't merge with it, so
an entry can be more open than its type as well as more closed. An override
applies to all translations of the entry, so one locale can't expose what
another hides. Overrides take effect when saved. They aren't part of the
entry's draft or revisions.

`account` and `auth` entries have their own access rules and take no visibility
rule.

## How a decision is made

A policy has an audience (`everyone`, `authenticated`, or `nobody`), allow and
deny lists for roles and users, and plugin rules. The first step that matches
wins:

| Order | Step | Result |
| ----- | ---- | ------ |
| 1 | The user is on the deny list | Denied |
| 2 | The user is on the allow list | Allowed |
| 3 | One of the viewer's roles is on the deny list | Denied |
| 4 | A rule in `require` mode doesn't allow | Denied |
| 5 | One of the viewer's roles is on the allow list | Allowed |
| 6 | A rule in `grant` mode allows | Allowed |
| 7 | The audience | Allowed or denied |

A viewer's roles are their primary role and any additional roles. Naming a user
outranks everything else, including a plugin that is down, because the operator
chose that person directly.

To check a decision, use **Check access** in the Visibility panel. It reports
whether an anonymous visitor, a role, or a user can view the entry, and which
rule decided. It reads the saved rule, not unsaved changes.

## What a hidden entry looks like

A visitor who can't view an entry gets the same result as if it didn't exist:

| Where | Result |
| ----- | ------ |
| Its URL, `?p=<id>`, old URLs, and translated URLs | 404 |
| `GET /api/v1/content/:slug` | 404 |
| `GET /api/v1/content` | Left out |
| Search, on the site and through the API | Left out, including from the totals |
| Blog lists, query blocks, and term archives | Left out, including from pagination |
| Menu links to the entry | Removed, with their children |
| Comment submissions | 404 |
| Sitemaps, feeds, and static export | Always evaluated as an anonymous visitor |
| `ctx.content.getPublished` and `listPublished` | Always evaluated as an anonymous visitor |
| External search services | Sent only entries open to everyone |
| `GET /api/v1/media` | Files used by a hidden entry are left out |

A hidden entry returns 404 rather than a teaser or a sign-in prompt. Those
belong to the rule builder tracked in
[#121](https://github.com/JustFlows/justflows-ce/issues/121).

Authorized previews still work. `?preview=1` for someone with `content:update`,
and a signed preview link, show the entry whatever its rules say, because
editors have to be able to check their work. The rules still apply to what
that page lists.

The public API uses the visitor's session cookie when there is one. API keys
belong to the management API, which is a staff tool and isn't affected.

### Media files

Visibility hides the entry, not the file. An image or download in a hidden entry
stays reachable at its `/uploads/...` URL for anyone who already has that URL.
It's no longer listed or linked, but the file itself isn't access-controlled.
Don't rely on visibility alone to protect a file. Use a plugin's private files
(`ctx.files`) for paid or confidential downloads.

### Caching

A page with a rule is never held by the page cache, a CDN, or a static export.
It's sent as `private, no-store`, even if its content type allows caching. Once
a site has any rule, lists and menus are built per visitor, and public API
responses are `private, no-store`.

Saving a rule clears cached pages, lists, and menus, purges the CDN, and syncs
search. Changing a type default rebuilds the search index in the background.
Until the rebuild finishes, an external search service can still hold entries
of that type, but results are always filtered again before they are returned.

## Adding a rule from a plugin

`ctx.visibility.registerRule` adds a rule type. It needs the `content:read`
permission. The rule is removed when the plugin deactivates, and it's stored on
policies as `<plugin id>:<rule id>`.

```ts
ctx.visibility.registerRule({
  id: "active-subscription",
  label: "Active subscription",
  description: "Only customers with an active subscription to the chosen plan.",
  scope: "viewer",
  fields: [
    {
      name: "plan",
      label: "Plan",
      type: "select",
      required: true,
      options: async () => (await listPlans()).map((plan) => ({ value: plan.id, label: plan.name })),
    },
  ],
  async evaluate({ viewer, params }) {
    if (!viewer.userId) return { effect: "deny", reason: "sign_in_required" };
    const active = await hasActiveSubscription(viewer.userId, String(params.plan));
    return active ? { effect: "allow", reason: "subscribed" } : { effect: "deny", reason: "no_subscription" };
  },
});
```

`plugins/hello-world/src/visibility-rule-example.ts` is a complete example.

### What an evaluator receives

| Field | Contents |
| ----- | -------- |
| `siteId` | The site being evaluated |
| `content` | `id`, `type`, `slug`, `locale`, `translationGroupId`, `status`, `authorId`. `null` for a `viewer`-scoped rule |
| `viewer` | `authenticated`, `userId`, `roles`. `userId` is `null` for anonymous visitors and when an editor checks a role |
| `params` | The values saved on the rule. Validate them, because they can be older than your plugin's current fields |
| `request` | `surface`: `request` or `explain` |

Evaluators never get the entry's body or fields, the viewer's email or name,
secrets, or the HTTP request. Everything passed in is frozen. If you need more
about a user, read it yourself under your plugin's own permissions.

Your answer must not depend on `request.surface`, or the same visitor would get
different answers in different places. For an anonymous visitor it can't depend
on anything but `params` and `content`, because the result can be cached and
shared.

### What an evaluator returns

Return `{ effect: "allow" | "deny", reason }`. `reason` is a code that matches
`^[a-z][a-z0-9_.-]{0,63}$`. Editors see it in Check access. Visitors never do.

### Scope

| `scope` | Evaluated | Use for |
| ------- | --------- | ------- |
| `item` (default) | Once per entry | Answers that depend on `content` |
| `viewer` | Once per request | Answers that depend only on the viewer and `params` |

Prefer `viewer` when it's accurate. An `item` rule on a large type is slower,
and each request evaluates at most the 2,000 newest published entries that use
it. Entries past that limit stay hidden.

### Failure

Visibility denies by default. Each of these counts as a failure:

| Failure | Reason shown |
| ------- | ------------ |
| The rule isn't registered, or its plugin is inactive on this site | `rule_unavailable` |
| The evaluator throws or takes longer than one second | `rule_error` |
| The answer is missing or malformed, or `reason` isn't a valid code | `rule_invalid` |

After a throw or a timeout, the rule isn't called again during that request.

A failed `require` rule denies. A failed `grant` rule grants nothing, so the
decision moves on to the audience. An entry stays hidden while a required
plugin is off, which means turning off a plugin can hide content. Deleting the
rule from the policy is how you open it up again.

A stored rule that can't be read is treated as `audience: "nobody"`.

### Versioning

`ctx.visibility` and the types above were added in SDK 0.1.8 and follow the
compatibility policy in [SDK-COMPATIBILITY.md](SDK-COMPATIBILITY.md).
