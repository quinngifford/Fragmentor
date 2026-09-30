import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The compiler only emits JavaScript; the window needs its markup too. */

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
