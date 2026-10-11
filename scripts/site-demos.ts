// Fresh, self-contained exports of the two example projects for the website's live demo.
// Run with: npm run site:demos
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { projectSnapshot } from "../src/project/snapshot.js";
import { checkLook, exportData, exportPage } from "../app/exportPage.js";

const repo = path.resolve(import.meta.dirname, "..");
const out = path.join(repo, "site", "demo");
const assets = {
  index: await readFile(path.join(repo, "app", "renderer", "index.html"), "utf8"),
  css: await readFile(path.join(repo, "app", "renderer", "styles.css"), "utf8"),
  script: await readFile(path.join(repo, "dist", "app", "renderer", "viewer.bundle.js"), "utf8"),
};
const wanted: Record<string, string> = { tickets: "book", messenger: "send" };
const work = await mkdtemp(path.join(tmpdir(), "fragmentor-site-demo-"));
for (const name of ["tickets", "messenger"]) {
  const dir = path.join(work, name);
  await cp(path.join(repo, "examples", name), dir, { recursive: true });
  const snapshot = await projectSnapshot(dir);
  const ids = snapshot.executions.map((e) => e.id);
  const pick = ids.find((id) => id.includes(wanted[name]!)) ?? ids[0]!;
  const look = checkLook(
    { colourBy: "role", roleColours: {}, blockColours: {}, showDependencies: true, legendCollapsed: true, folded: [], execution: { id: pick, at: 0 } },
    snapshot,
  );
  const page = exportPage(assets, exportData(snapshot, look, { date: "2026-10-10", home: homedir() }), [dir, homedir()]);
  await writeFile(path.join(out, `${name}.html`), page, "utf8");
  console.log(`${name}: ${Object.keys(snapshot.blocks).length} blocks, executions ${ids.join(", ")} (picked ${pick}), ${Math.round(page.length / 1024)} KB`);
}
await rm(work, { recursive: true, force: true });
