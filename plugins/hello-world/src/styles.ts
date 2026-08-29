import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@justflows/sdk";

const MARKER = "/* justflows.hello-world */";
let cachedCss: string | undefined;

/** Register plugin-owned public CSS in the shared site stylesheet. */
export async function registerHelloWorldStyles(ctx: PluginContext): Promise<void> {
  cachedCss ??= (
    await readFile(
      fileURLToPath(new URL("./styles/hello-world.css", import.meta.url)),
      "utf8",
    )
  ).trim();

  ctx.hooks.filter("theme.css", (current) =>
    current.includes(MARKER)
      ? current
      : `${current}\n${MARKER}\n${cachedCss}\n`,
  );
}
