import type { PluginModule, PluginContext } from "@justflows/sdk";
import { registerHelloWorldStyles } from "./styles.js";

let dispose: (() => void) | undefined;

const helloWorld: PluginModule = {
  manifest: {
    id: "justflows.hello-world",
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
