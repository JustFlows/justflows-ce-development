import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const source = fileURLToPath(new URL("../src/styles/hello-world.css", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist/styles/", import.meta.url));
const output = fileURLToPath(new URL("../dist/styles/hello-world.css", import.meta.url));

const { code, warnings } = await transform(await readFile(source, "utf8"), {
  loader: "css",
  minify: true,
  legalComments: "none",
});

for (const warning of warnings) console.warn(`[hello-world:css] ${warning.text}`);

await mkdir(outputDirectory, { recursive: true });
await writeFile(output, code);
