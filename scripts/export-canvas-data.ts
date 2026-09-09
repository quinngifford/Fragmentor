import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "../src/project/project.js";
import { formatWire } from "../src/model/block.js";
import { describeType } from "../src/model/types.js";
import { executionOrder, wireCarriedType } from "../src/model/validate.js";

/**
 * Dumps the example project in the shape the canvas prototype consumes, so
 * the drawing is produced from blocks the real loader and validator read
 * rather than from anything retyped by hand.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const project = await loadProject(path.join(here, "..", "examples", "job-ranker"));

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
  };
}

console.log(
  JSON.stringify(
    { manifest: project.manifest, rootPath: project.root.path, blocks },
    null,
    2,
  ),
);
