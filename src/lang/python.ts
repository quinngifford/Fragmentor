import type { Block } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import type { CapabilityOperation } from "../model/capabilities.js";
import type { PortType } from "../model/types.js";
import { planComposite } from "./composite.js";
import type { Binding, Naming } from "./composite.js";
import { pascalCase, snakeCase } from "./naming.js";
import { registerPack } from "./pack.js";
import type { ContractRequest, LanguagePack } from "./pack.js";

/**
 * Python, validated with pydantic.
 *
 * This pack exists as much to keep the kernel honest as to target Python. Two
 * places where Python differs from TypeScript are worth knowing about:
 *
 * Capabilities stay structural. A Caps protocol means a block needing `files`
 * accepts anything that has a `files` attribute, so a parent can pass its whole
 * caps object down exactly as in TypeScript. A nominally typed language would
 * need each call site to build the child's caps explicitly instead.
 *
 * Anonymous object types do not exist. Every object in a port type becomes a
 * named model, so the pack has to invent deterministic names for shapes that
 * TypeScript writes inline.
 */

const UNIMPLEMENTED = "has no implementation yet";

/**
 * pydantic reserves the `model_` prefix for its own attributes and warns when
 * a field uses it. A port called `modelName` snake-cases straight into that,
 * so every generated model opts out rather than leaving the user to discover
 * a warning in code they did not write.
 */
const MODEL_CONFIG = "    model_config = ConfigDict(protected_namespaces=())";

interface ModelSink {
  declarations: string[];
}

/**
 * Renders a port type as a Python annotation, declaring a model for every
 * object it contains. `hint` seeds the names of those models.
 */
function annotation(type: PortType, hint: string, sink: ModelSink): string {
  switch (type.kind) {
    case "string":
      return "str";
    case "number":
      // Fragmentor has one number type; pydantic accepts an int where a float
      // is declared, so this is wider than TypeScript rather than narrower.
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "unknown":
    case "text":
      return "Any";
    case "literal":
      return typeof type.value === "boolean"
        ? `Literal[${type.value ? "True" : "False"}]`
        : `Literal[${JSON.stringify(type.value)}]`;
    case "enum":
      return `Literal[${type.values.map((value) => JSON.stringify(value)).join(", ")}]`;
    case "array":
      return `list[${annotation(type.of, `${hint}Item`, sink)}]`;
    case "union":
      return type.of.map((member, i) => annotation(member, `${hint}Option${i + 1}`, sink)).join(" | ");
    case "object": {
      const entries = Object.entries(type.fields);
      if (entries.length === 0) {
        sink.declarations.push(`class ${hint}(BaseModel):\n${MODEL_CONFIG}\n    pass`);
        return hint;
      }

      const fields = entries.map(([name, field]) => {
        const inner = annotation(field.type, hint + pascalCase(snakeCase(name).replace(/_/g, "-")), sink);
        // An optional field in Fragmentor may be absent. Python's nearest
        // equivalent on a model is a default, which also permits an explicit
        // None; the two are not quite the same thing.
        return field.optional
          ? `    ${snakeCase(name)}: ${inner} | None = None`
          : `    ${snakeCase(name)}: ${inner}`;
      });

      sink.declarations.push(`class ${hint}(BaseModel):\n${MODEL_CONFIG}\n${fields.join("\n")}`);
      return hint;
    }
  }
}

function portsModel(name: string, ports: Block["inputs"], sink: ModelSink): string {
  const entries = Object.entries(ports);
  if (entries.length === 0) return `class ${name}(BaseModel):\n${MODEL_CONFIG}\n    pass`;

  const fields = entries.map(([portName, port]) => {
    const inner = annotation(port.type, name + pascalCase(portName.replace(/_/g, "-")), sink);
    return `    ${snakeCase(portName)}: ${inner}`;
  });

  return `class ${name}(BaseModel):\n${MODEL_CONFIG}\n${fields.join("\n")}`;
}

/**
 * A type in a capability's signature. The capability's own parameter is
 * written as free text in the catalogue, which every other pack renders
 * verbatim; here it has to survive as the TypeVar rather than collapse to
 * `Any` the way free text otherwise does.
 */
function capabilityAnnotation(type: PortType, parameter: string | undefined): string {
  if (parameter !== undefined && type.kind === "text" && type.text === parameter) return parameter;
  if (type.kind === "array") return `list[${capabilityAnnotation(type.of, parameter)}]`;
  if (type.kind === "union") return type.of.map((member) => capabilityAnnotation(member, parameter)).join(" | ");
  return annotation(type, "Value", { declarations: [] });
}

function operationSignature(operation: CapabilityOperation, parameter?: string): string {
  const parameters = operation.parameters
    .map((each) => `${snakeCase(each.name)}: ${capabilityAnnotation(each.type, parameter)}`)
    .join(", ");
  const returns = operation.returns ? capabilityAnnotation(operation.returns, parameter) : "None";
  const prefix = operation.async ? "async def" : "def";
  const args = parameters ? `self, ${parameters}` : "self";
  return `    ${prefix} ${snakeCase(operation.name)}(${args}) -> ${returns}: ...`;
}

const GENERATED = "# Generated by Fragmentor from block.json. Do not edit: change the diagram instead.";

/** Words Python will not take as a variable, and names the generated code already uses. */
const RESERVED = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case", "type",
  "value", "caps", "result", "asyncio",
]);

const naming: Naming = {
  variable: (port) => snakeCase(port),
  qualified: (first, second) => `${snakeCase(first)}_${snakeCase(second)}`,
  functionName: snakeCase,
  results: (blockId, each) => `${snakeCase(blockId)}_${each ? "results" : "result"}`,
  reserved: RESERVED,
};

const modelName = (blockId: string, role: "Input" | "Output" | "Caps") => `${pascalCase(blockId)}${role}`;
const keywords = (bindings: Binding[]) => bindings.map(({ port, variable }) => `${snakeCase(port)}=${variable}`).join(", ");

/**
 * Where a child's code is imported from is provisional: it assumes a block's
 * folder is on the path and its children are packages beneath it, which is
 * the module layout question STATUS.md records as unsettled. Nothing runs
 * Python blocks yet, so nothing depends on the answer.
 */
function compositeSource(block: Block): string {
  const plan = planComposite(block, naming);

  const paragraphs: string[] = [];
  if (plan.inputs.length > 0) {
    paragraphs.push(plan.inputs.map(({ port, variable }) => `    ${variable} = value.${snakeCase(port)}`).join("\n"));
  }

  for (const step of plan.steps) {
    const call = `${step.callee}(${modelName(step.child, "Input")}(${keywords(step.args)}), caps)`;
    const lines: string[] = [];
    if (step.each) {
      const gather = `await asyncio.gather(*(${call} for ${step.each.item} in ${step.each.over}))`;
      lines.push(step.result ? `    ${step.result} = ${gather}` : `    ${gather}`);
      for (const produced of step.outputs) {
        lines.push(`    ${produced.variable} = [result.${snakeCase(produced.port)} for result in ${step.result}]`);
      }
    } else {
      lines.push(step.result ? `    ${step.result} = await ${call}` : `    await ${call}`);
      for (const produced of step.outputs) lines.push(`    ${produced.variable} = ${step.result}.${snakeCase(produced.port)}`);
    }
    paragraphs.push(lines.join("\n"));
  }

  paragraphs.push(`    return ${modelName(block.id, "Output")}(${keywords(plan.returns)})`);

  return [
    GENERATED,
    ``,
    ...(plan.steps.some((step) => step.each) ? [`import asyncio`, ``] : []),
    `from contract import ${modelName(block.id, "Input")}, ${modelName(block.id, "Output")}, ${modelName(block.id, "Caps")}`,
    ...plan.callees.flatMap(({ child, name, local }) => [
      `from ${snakeCase(child)}.contract import ${modelName(child, "Input")}`,
      `from ${snakeCase(child)}.impl import ${name === local ? name : `${name} as ${local}`}`,
    ]),
    ``,
    ``,
    `async def ${snakeCase(block.id)}(value: ${modelName(block.id, "Input")}, caps: ${modelName(block.id, "Caps")}) -> ${modelName(block.id, "Output")}:`,
    `    """${block.responsibility}"""`,
    paragraphs.join("\n\n"),
    ``,
  ].join("\n");
}

export const pythonPack: LanguagePack = {
  id: "python",
  displayName: "Python",
  contractFile: "contract.py",
  implFile: "impl.py",
  capabilitiesFile: "capabilities.py",

  functionName: (blockId) => snakeCase(blockId),
  typeName: (blockId, role) => `${pascalCase(blockId)}${role}`,
  typeExpression: (type) => annotation(type, "Value", { declarations: [] }),

  contractSource({ block, bound }: ContractRequest): string {
    const sink: ModelSink = { declarations: [] };
    const inputName = this.typeName(block.id, "Input");
    const outputName = this.typeName(block.id, "Output");
    const capsName = this.typeName(block.id, "Caps");

    const inputModel = portsModel(inputName, block.inputs, sink);
    const outputModel = portsModel(outputName, block.outputs, sink);

    const capabilities = Object.entries(block.capabilities);
    const capabilityTypes = [...new Set(capabilities.map(([, cap]) => cap.capability))].sort();

    const header = [
      `# Generated by Fragmentor from block.json. Do not edit.`,
      `# ${block.name}: ${block.responsibility}`,
      ``,
      `from __future__ import annotations`,
      ``,
      `from typing import Any, Literal, Protocol`,
      ``,
      `from pydantic import BaseModel, ConfigDict`,
    ];

    if (capabilityTypes.length > 0) {
      header.push(``, `from capabilities import ${capabilityTypes.join(", ")}`);
    }

    const capsLines = capabilities.length === 0
      ? [`class ${capsName}(Protocol):`, `    """${block.name} needs no effects supplied from outside."""`]
      : [
          `class ${capsName}(Protocol):`,
          ...capabilities.map(([name, cap]) => {
            // A parameterised capability is written in terms of what it is a
            // way into, whose shape becomes a model like any other.
            const parameter = CAPABILITIES[cap.capability]?.parameter;
            const row = parameter ? bound?.[name] : undefined;
            const type = parameter
              ? `${cap.capability}[${row ? annotation(row, `${pascalCase(block.id)}${pascalCase(snakeCase(name).replace(/_/g, "-"))}`, sink) : "Any"}]`
              : cap.capability;
            return cap.description
              ? `    ${snakeCase(name)}: ${type}\n    """${cap.description}"""`
              : `    ${snakeCase(name)}: ${type}`;
          }),
        ];

    // Nested models have to be declared before the models that use them.
    const body = [...sink.declarations, inputModel, outputModel, capsLines.join("\n")];

    return `${[...header, ``, ``, body.join("\n\n\n")].join("\n")}\n`;
  },

  implScaffold(block: Block): string {
    const input = this.typeName(block.id, "Input");
    const output = this.typeName(block.id, "Output");
    const caps = this.typeName(block.id, "Caps");
    const fn = snakeCase(block.id);

    return [
      `from contract import ${input}, ${output}, ${caps}`,
      ``,
      ``,
      `async def ${fn}(value: ${input}, caps: ${caps}) -> ${output}:`,
      `    """${block.responsibility}"""`,
      `    raise NotImplementedError("${block.name} ${UNIMPLEMENTED}.")`,
      ``,
    ].join("\n");
  },

  compositeSource,

  capabilitiesSource(): string {
    const parameters = [...new Set(Object.values(CAPABILITIES).map((each) => each.parameter).filter(Boolean))] as string[];

    const declarations = Object.values(CAPABILITIES).map((capability) => {
      const operations = capability.operations
        .map((operation) => operationSignature(operation, capability.parameter))
        .join("\n");
      const head = capability.parameter
        ? `class ${capability.name}(Protocol, Generic[${capability.parameter}])`
        : `class ${capability.name}(Protocol)`;
      return `${head}:\n    """${capability.description}"""\n\n${operations}`;
    });

    return [
      `# Generated by Fragmentor. Do not edit.`,
      ``,
      `from __future__ import annotations`,
      ``,
      `from typing import Any, Generic, Protocol, TypeVar`,
      ``,
      ``,
      ...(parameters.length > 0 ? [parameters.map((name) => `${name} = TypeVar("${name}")`).join("\n"), ``, ``] : []),
      declarations.join("\n\n\n"),
      ``,
    ].join("\n");
  },

  // Generating Python works; running it needs the module layout question
  // in STATUS.md settled first.
  canRun: false,
  canCheck: false,
  isUnimplemented: (source) => source.includes(UNIMPLEMENTED),
};

registerPack(pythonPack);
