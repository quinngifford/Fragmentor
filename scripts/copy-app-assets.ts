import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * The compiler only emits JavaScript; the window needs its markup too. And
 * an exported page needs one script holding everything it draws with, which
 * is bundled here from the window's own reading modules.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const assets = [
  ["app/preload.cjs", "dist/app/preload.cjs"],
  ["src/run/harness.cjs", "dist/src/run/harness.cjs"],
  ["src/run/harness.py", "dist/src/run/harness.py"],
  ["src/codegen/guide.md", "dist/src/codegen/guide.md"],
  ["app/renderer/index.html", "dist/app/renderer/index.html"],
  ["app/renderer/styles.css", "dist/app/renderer/styles.css"],
];

for (const [from, to] of assets) {
  const target = path.join(root, to!);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, from!), target);
}

console.log(`Copied ${assets.length} assets into dist.`);

/**
 * Modules an exported page must never hold: each talks to the application, or
 * is a part of it a page that only reads has no use for. A page holding one
 * would be the beginning of a web version of the application, which there is not.
 */
const APP_ONLY = ["app", "inspector", "notes", "versions", "bench", "benchpanel", "watch", "newproject", "changes", "rules", "analytics"].map(
  (name) => `app/renderer/${name}.ts`,
);

const bundled = await build({
  entryPoints: [path.join(root, "app", "renderer", "viewer.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  metafile: true,
  write: false,
  logLevel: "silent",
});

const inputs = Object.keys(bundled.metafile.inputs).map((input) => input.split(path.sep).join("/"));
const forbidden = inputs.filter((input) => APP_ONLY.some((name) => input.endsWith(name)));
const script = bundled.outputFiles[0]!.text;
if (forbidden.length > 0 || script.includes("window.fragmentor")) {
  throw new Error(
    `The exported page's script must not talk to the application, and it ${forbidden.length > 0 ? `brings in ${forbidden.join(", ")}` : "uses window.fragmentor"}. Keep what the page imports to the reading modules.`,
  );
}

const target = path.join(root, "dist", "app", "renderer", "viewer.bundle.js");
await writeFile(target, script, "utf8");
console.log(`Bundled the export page's script: ${inputs.length} modules, ${Math.round(script.length / 1024)} KB.`);
