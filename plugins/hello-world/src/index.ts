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
    permissions: [],
    main: "index.js",
    registry: {
      commercialMarketplace: false,
      listed: true,
      free: true,
      comingSoon: false,
    },
  },

  async activate(ctx: PluginContext) {
    ctx.logger.info("Hello World plugin activating");

    await registerHelloWorldStyles(ctx);

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
