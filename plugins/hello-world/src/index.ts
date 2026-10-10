import type { PluginModule, PluginContext } from "@justflows/sdk";
import { registerHelloWorldStyles } from "./styles.js";

let dispose: (() => void) | undefined;

const helloWorld: PluginModule = {
  manifest: {
    id: "justflows.hello-world",
    apiNamespace: "hello-world",
    name: "Hello World",
    version: "1.0.0",
    description: "The official example plugin that demonstrates the Justflows plugin lifecycle.",
    author: "Justflows Team",
    license: "GPL-2.0-or-later",
    engines: { justflows: ">=0.1.8 <0.2.0" },
    permissions: [],
    main: "index.js",
    registry: {
      commercialMarketplace: false,
      listed: true,
      free: true,
      comingSoon: false,
    },
    // Client script shipped in the package. The host serves `public/**` at
    // `/ext/justflows.hello-world/**` and adds `<script src=".../hello-world.js">`
    // to every public page — no ctx.http route or html.head filter needed.
    assets: {
      dir: "public",
      scripts: ["hello-world.js"],
    },
  },

  async activate(ctx: PluginContext) {
    ctx.logger.info("Hello World plugin activating");

    await registerHelloWorldStyles(ctx);
    // Relative routes also resolve through the neutral API namespace. The legacy
    // /ext/justflows.hello-world/status alias remains supported.
    ctx.http.get("status", async () => ({ body: { ok: true } }));
    // Use ctx.http.url("status") when emitting links; browser bundles can use
    // pluginApiUrl("hello-world", "status") from the SDK.
    // Optional account integration: call registerAccountExample(ctx) below after
    // adding users:read to the manifest.
    // Optional external search integration: see search-backend-example.ts and
    // docs/SEARCH.md. It is not enabled by this zero-permission example.

    ctx.patterns.register({
      id: "welcome-cta",
      title: "Hello World call to action",
      description:
        "A plugin-contributed call to action that remains fully editable after insertion.",
      category: "calls-to-action",
      blocks: [
        {
          id: "hello-world-cta",
          type: "core.cta",
          version: 1,
          props: {
            heading: "Build your next idea with Justflows",
            text: "This pattern was registered by the Hello World plugin.",
            buttonLabel: "Learn more",
            buttonUrl: "/",
            variant: "primary",
          },
        },
      ],
    });

    // A default image for a kind this plugin owns. Site owners can replace it
    // in Admin → Settings → Placeholders. In a block's render(), use
    // `ctx.media.placeholderHtml("justflows.hello-world.card")` for an empty slot.
    ctx.media.registerPlaceholder("justflows.hello-world.card", {
      src: "/ext/justflows.hello-world/hello-world-placeholder.svg",
      width: 600,
      height: 400,
      label: "Hello World card",
    });

    // A plugin-owned meter. Call check before inserting a row. Core meters
    // (sites, users, content, media.bytes) are counted by the host. An empty
    // limit is unlimited. set() needs the platform:tenancy permission.
    ctx.quotas.register({
      key: "justflows.hello-world.notes",
      scope: "site",
      label: "Hello World notes",
      unit: "count",
    });
    try {
      const notes = await ctx.quotas.check("justflows.hello-world.notes", { delta: 1, used: 0 });
      if (!notes.ok) {
        ctx.logger.info("Hello World: note limit reached", { limit: notes.limit ?? 0 });
      }
    } catch (err) {
      ctx.logger.warn("Hello World: could not read the note limit", {
        error: err instanceof Error ? err.message : "failed",
      });
    }

    dispose = ctx.hooks.action("content.published", async (event) => {
      ctx.logger.info("Hello World: content was published", {
        contentId: event.contentId,
        siteId: event.siteId,
      });
    });

    await ctx.settings.set("activated", true);
    ctx.logger.info("Hello World plugin activated");
  },

  async deactivate(ctx: PluginContext) {
    dispose?.();
    dispose = undefined;
    ctx.logger.info("Hello World plugin deactivated");
  },

  async deleteData(ctx: PluginContext) {
    ctx.logger.info("Hello World plugin deleteData (no stored data)");
  },
};

export default helloWorld;


/** Optional account contribution example; requires users:read in the manifest. */
export function registerAccountExample(ctx: PluginContext): void {
  ctx.hooks.filter("account.sections", (sections, account) => [...sections, {
    id: "justflows.hello-world.account", title: "Hello World", cards: [{
      title: "Your plugin account", fields: [{ label: "Email", value: account.email }],
      links: [{ label: "Return to the site", href: "/" }],
    }],
  }]);
}
