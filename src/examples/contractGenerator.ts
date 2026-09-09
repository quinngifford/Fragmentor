import type { Proposal } from "../ai/decompose.js";
import type { Block } from "../model/block.js";
import type { Manifest } from "../project/project.js";
import { parseType } from "../model/typeExpression.js";

/**
 * Fragmentor describing one of its own parts.
 *
 * This is the contract generator: given a block's ports, produce the
 * TypeScript source for its contract. It was chosen as the self-hosted
 * example because it is genuinely straight-line dataflow, unlike most of the
 * kernel, and because its output is something the project actually consumes.
 *
 * Note what the ports carry. A port type cannot describe a Fragmentor port
 * type — the type language has no recursion — so types cross this boundary as
 * expression strings, and the recursion lives inside a leaf where it belongs.
 */

export const contractGeneratorManifest: Manifest = {
  name: "Contract Generator",
  goal:
    "Given one block's name, responsibility and ports, produce the TypeScript source of its contract: a runtime schema and a derived type for its inputs and outputs, and an interface for the effects it needs supplied.",
  systems: [{ rootBlock: "generate-contract", language: "typescript" }],
  granularity: { level: 3, maxDepth: 3 },
};

const PORT_LIST = "{ name: string; type: string; description?: string }[]";
const CAPABILITY_LIST = "{ name: string; capability: string; description?: string }[]";

export const generateContractSeed: Block = {
  id: "generate-contract",
  name: "Generate Contract",
  responsibility:
    "Produce the TypeScript contract source for one block from its ports, so the contract can never disagree with the diagram.",
  kind: "leaf",
  inputs: {
    blockId: { type: parseType("string"), description: "Kebab-case id, e.g. score-posting." },
    blockName: { type: parseType("string") },
    responsibility: { type: parseType("string") },
    blockPath: { type: parseType("string"), description: "Path from the blocks root, used to locate shared modules." },
    inputs: { type: parseType(PORT_LIST), description: "Each type is an expression such as `string[]`." },
    outputs: { type: parseType(PORT_LIST) },
    capabilities: { type: parseType(CAPABILITY_LIST) },
  },
  outputs: {
    source: { type: parseType("string"), description: "Contents of the block's contract.ts." },
  },
  capabilities: {},
  children: [],
  wires: [],
  pinnedAsLeaf: false,
};

export const generateContractProposal: Proposal = {
  reasoning:
    "Names are derived once and used by two later steps. Rendering the port schemas and rendering the capability declaration are independent of each other, and both feed a final step that only assembles text. The recursion over nested port types stays inside the schema renderer, where a leaf can express it.",
  children: [
    {
      id: "derive-names",
      name: "Derive Names",
      responsibility:
        "Turn a kebab-case block id into the function name and the type-name stem used throughout the generated file.",
      inputs: { blockId: { type: "string" } },
      outputs: { functionName: { type: "string" }, typeStem: { type: "string" } },
      likelyLeaf: true,
    },
    {
      id: "render-schemas",
      name: "Render Schemas",
      responsibility:
        "Render the zod object expression for the input ports and for the output ports, expanding each port's type expression into a schema.",
      inputs: { inputs: { type: PORT_LIST }, outputs: { type: PORT_LIST } },
      outputs: { inputSchema: { type: "string" }, outputSchema: { type: "string" } },
      likelyLeaf: true,
    },
    {
      id: "render-capabilities",
      name: "Render Capabilities",
      responsibility:
        "Render the import of the capability types a block uses and the interface describing what must be supplied to it.",
      inputs: {
        blockName: { type: "string" },
        blockPath: { type: "string" },
        typeStem: { type: "string" },
        capabilities: { type: CAPABILITY_LIST },
      },
      outputs: { importLine: { type: "string" }, capsDeclaration: { type: "string" } },
      likelyLeaf: true,
    },
    {
      id: "assemble-source",
      name: "Assemble Source",
      responsibility: "Lay the rendered pieces out as a complete TypeScript file with its generated-file header.",
      inputs: {
        blockName: { type: "string" },
        responsibility: { type: "string" },
        functionName: { type: "string" },
        typeStem: { type: "string" },
        inputSchema: { type: "string" },
        outputSchema: { type: "string" },
        importLine: { type: "string" },
        capsDeclaration: { type: "string" },
      },
      outputs: { source: { type: "string" } },
      likelyLeaf: true,
    },
  ],
  wires: [
    { from: "input.blockId", to: "derive-names.blockId" },
    { from: "input.inputs", to: "render-schemas.inputs" },
    { from: "input.outputs", to: "render-schemas.outputs" },
    { from: "input.blockName", to: "render-capabilities.blockName" },
    { from: "input.blockPath", to: "render-capabilities.blockPath" },
    { from: "input.capabilities", to: "render-capabilities.capabilities" },
    { from: "derive-names.typeStem", to: "render-capabilities.typeStem" },
    { from: "input.blockName", to: "assemble-source.blockName" },
    { from: "input.responsibility", to: "assemble-source.responsibility" },
    { from: "derive-names.functionName", to: "assemble-source.functionName" },
    { from: "derive-names.typeStem", to: "assemble-source.typeStem" },
    { from: "render-schemas.inputSchema", to: "assemble-source.inputSchema" },
    { from: "render-schemas.outputSchema", to: "assemble-source.outputSchema" },
    { from: "render-capabilities.importLine", to: "assemble-source.importLine" },
    { from: "render-capabilities.capsDeclaration", to: "assemble-source.capsDeclaration" },
    { from: "assemble-source.source", to: "output.source" },
  ],
};
