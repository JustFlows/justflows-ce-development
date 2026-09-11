# Webhooks

Justflows can push content and media lifecycle events to external HTTP services.
Administrators manage endpoints and inspect attempts at **Admin → Webhooks**.

An integration can also register and manage **its own** endpoint over HTTP with
an API key (`settings:manage`), so no administrator has to wire it by hand — see
the [Federated management API](FEDERATED-API.md) (`/api/manage/v1/webhooks` and
the `/events` catalog).

## Events

Core provides content create/update/publish/unpublish/delete, media
upload/delete, user create/update/delete, login/logout, plugin
install/activate/deactivate/uninstall, theme install/activate, and core-update
events. Each endpoint subscribes to one or more events. Delivery is
asynchronous: the originating action does not wait for the receiver.

The JSON body is capped at 256 KiB:

```json
{
  "id": "event UUID",
  "event": "content.published",
  "createdAt": "2026-08-31T12:00:00.000Z",
  "data": { "contentId": "…", "siteId": "…", "type": "page" }
}
```

## Verify a signature

The secret is shown only when an endpoint is created or its secret is rotated.
Store it in the receiver's secret manager. Justflows sends:

- `X-Justflows-Delivery`: the delivery UUID
- `X-Justflows-Timestamp`: Unix time in seconds
- `X-Justflows-Signature`: `sha256=` plus a hex HMAC-SHA256 digest

Build the signed bytes as `<timestamp>.<raw request body>` and calculate the
HMAC with the endpoint secret. Compare digests in constant time and reject old
timestamps (five minutes is a typical replay window). Always verify the raw
body before parsing JSON.

## Retries and history

Non-2xx responses, timeouts, DNS failures, and connection errors retry through
the jobs scheduler with exponential backoff. A delivery is marked failed after
five attempts. Admin → Webhooks retains the latest delivery records, response
status/body excerpt, error, and a manual **Redeliver** control.

Endpoint URLs are checked when saved and immediately before delivery. Local,
private, link-local, multicast, credential-bearing, and non-HTTP(S) targets are
rejected; redirects are not followed. Responses and errors stored in history
are bounded.

## Plugin-defined events

A plugin adds its namespaced action to the selectable event names with
`webhook.eventTypes`. Emitting that action then uses the same persisted webhook
delivery path as core events:

```ts
activate(ctx) {
  ctx.hooks.filter("webhook.eventTypes", (events) => [
    ...events,
    "acme.orders.completed",
  ]);

  await ctx.hooks.emit("acme.orders.completed", { orderId: "order-123" });
}
```

Use a namespaced event name and JSON-serializable, non-secret data. The plugin
runtime adds the current site ID to the hook context when emitting.

Plugins can also shape data for every outbound event and observe each delivery
attempt:

```ts
ctx.hooks.filter("webhook.payload", (data, { event }) => {
  return event === "acme.orders.completed" ? { ...data, source: "shop" } : data;
});

ctx.hooks.action("webhook.delivered", ({ event, status, responseStatus, data }) => {
  ctx.logger.info("Webhook result", { event, status, responseStatus, data });
});
```

`webhook.payload` runs before the envelope is bounded and signed.
`webhook.delivered` receives the event data and the bounded receiver response or
error after every attempt; it never receives another endpoint's secret.

## Scheduled content

Setting, changing or cancelling a schedule does not send a publication webhook.
At the actual publish/expiry transition, matching delivery rows are queued in
the same database transaction as content. The subsequent action dispatch does
not enqueue those deliveries again. The payload includes `eventId` and
`scheduleEventId`; delivery retries retain their normal signed delivery identity.
A completely missed publication window expires without a publication webhook.
See [Scheduled publishing](SCHEDULING.md).
