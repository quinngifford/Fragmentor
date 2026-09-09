import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadProject } from "../src/project/project.js";
import { formatWire, functionNameOf } from "../src/model/block.js";
import { describeType } from "../src/model/types.js";
import { executionOrder, wireCarriedType } from "../src/model/validate.js";

/**
 * Builds the canvas prototype from the example projects.
 *
 * The drawing is produced from blocks the real loader and validator read, and
 * the page carries each block's generated sources so the code panel shows what
 * is actually on disk. The finished page's script is parsed before it is
 * written, because a page that does not parse renders nothing at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "prototypes", "canvas.template.html");
const outputPath = path.join(here, "..", "prototypes", "canvas.html");

const projectDirs = [
  { key: "job-ranker", label: "Job Ranker" },
  { key: "contract-generator", label: "Contract Generator" },
];

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function exportProject(key: string, label: string) {
  const project = await loadProject(path.join(here, "..", "examples", key));
  const blocks: Record<string, unknown> = {};

  for (const [blockPath, node] of project.byPath) {
    const block = node.block;
    const childBlocks = new Map(node.children.map((c) => [c.block.id, c.block]));

    const ports = (record: typeof block.inputs) =>
      Object.entries(record).map(([name, port]) => ({
        name,
        type: describeType(port.type),
        typeIr: port.type,
        description: port.description ?? null,
      }));

    blocks[blockPath] = {
      path: blockPath,
      id: block.id,
      name: block.name,
      responsibility: block.responsibility,
      kind: block.kind,
      functionName: functionNameOf(block.id),
      inputs: ports(block.inputs),
      outputs: ports(block.outputs),
      capabilities: Object.entries(block.capabilities).map(([name, cap]) => ({
        name,
        capability: cap.capability,
        description: cap.description ?? null,
      })),
      children: block.children.map((child) => ({
        block: child.block,
        mode: child.mode,
        eachOver: child.eachOver ?? null,
        path: `${blockPath}/${child.block}`,
        kind: childBlocks.get(child.block)?.kind ?? "leaf",
        name: childBlocks.get(child.block)?.name ?? child.block,
        functionName: functionNameOf(child.block),
      })),
      order: executionOrder(block.children, block.wires),
      wires: block.wires.map((wire) => {
        const carried = wireCarriedType(block, childBlocks, wire);
        return {
          text: formatWire(wire),
          source: wire.source,
          target: wire.target,
          type: carried ? describeType(carried) : null,
          isArray: carried?.kind === "array",
        };
      }),
      sources: {
        impl: await readIfPresent(path.join(node.dir, "impl.ts")),
        contract: await readIfPresent(path.join(node.dir, "contract.ts")),
      },
    };
  }

  return { key, label, manifest: project.manifest, rootPath: project.root.path, blocks, blockCount: project.byPath.size };
}

const exported = [];
for (const { key, label } of projectDirs) exported.push(await exportProject(key, label));
const data = JSON.stringify(exported, null, 2);

const template = await readFile(templatePath, "utf8");
const PLACEHOLDER = "/*__DATA__*/";
if (!template.includes(PLACEHOLDER)) throw new Error(`The template no longer contains ${PLACEHOLDER}.`);

// A string replacement, not a pattern: "$" sequences in JSON must stay literal.
const page = template.replace(PLACEHOLDER, () => data);

const scriptStart = page.indexOf("<script>");
const scriptEnd = page.lastIndexOf("</" + "script>");
if (scriptStart < 0 || scriptEnd < 0) throw new Error("Could not find the page script to check.");

try {
  new vm.Script(page.slice(scriptStart + "<script>".length, scriptEnd), { filename: "canvas.html" });
} catch (cause) {
  throw new Error(`The page script does not parse, so it would render nothing:\n${String(cause)}`);
}

await writeFile(outputPath, page, "utf8");

const total = exported.reduce((n, p) => n + p.blockCount, 0);
console.log(
  `Wrote ${path.relative(process.cwd(), outputPath)} — ${exported.length} projects, ${total} blocks, script parses.`,
);
