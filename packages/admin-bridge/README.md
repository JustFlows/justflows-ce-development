# @justflows/admin-bridge

The tiny client a plugin's **admin app** (`manifest.adminApp`) uses to talk to
the Justflows admin shell.

A plugin admin screen runs in a same-origin `<iframe>` inside the admin. This
package is the entire contract between the two sides: a small `postMessage`
protocol — no shared framework, no host globals, no core React.

```ts
import { createAdminBridge } from "@justflows/admin-bridge";

const bridge = createAdminBridge();

bridge.onContext((ctx) => {
  // { locale, adminBase, routePath, theme } — render your app
});
bridge.onRoute((routePath) => {
  // the admin URL changed under your plugin's path — follow it in your router
});
bridge.autoResize();  // keep the iframe sized to your content
bridge.ready();        // tell the host you have mounted; it replies with context
```

## API

| Member | Purpose |
| ------ | ------- |
| `ready()` | announce the app mounted; the host replies by delivering `context` |
| `context()` | the last `AdminContext` delivered, or `null` |
| `onContext(fn)` | subscribe to context (replays the latest to late subscribers) |
| `onRoute(fn)` | host-driven navigation under your plugin's path subtree |
| `navigate(path)` | ask the host to go to another `/admin/…` page (or an absolute URL → new tab) |
| `reportSections(sections)` | publish content-editor menu entries (`{ id, label }`) |
| `onSection(fn)` | the host selected one of those entries |
| `reportHeight(px)` | one-off height report |
| `autoResize(el?)` | observe an element and report its height on change; returns a stop fn |
| `destroy()` | remove every listener/observer this bridge installed |

## Notes

- The iframe is **same-origin**: read the CSRF cookie yourself
  (`document.cookie` → `jf_csrf`, send it as `X-CSRF-Token`) and call your
  plugin's own `ctx.http` routes for data. Nothing is proxied through core.
- Messages are validated on both ends by `event.origin` **and** `event.source`.
- No dependencies. Ship it in your admin build (bundle it, or vendor
  `dist/index.js` beside your `index.html`).
