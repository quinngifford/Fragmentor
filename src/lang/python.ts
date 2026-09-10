import type { Block } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import type { CapabilityOperation } from "../model/capabilities.js";
import type { PortType } from "../model/types.js";
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

function operationSignature(operation: CapabilityOperation): string {
  const parameters = operation.parameters
    .map((parameter) => `${snakeCase(parameter.name)}: ${annotation(parameter.type, "Value", { declarations: [] })}`)
    .join(", ");
  const returns = operation.returns ? annotation(operation.returns, "Value", { declarations: [] }) : "None";
  const prefix = operation.async ? "async def" : "def";
  const args = parameters ? `self, ${parameters}` : "self";
  return `    ${prefix} ${snakeCase(operation.name)}(${args}) -> ${returns}: ...`;
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

  contractSource({ block }: ContractRequest): string {
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
          ...capabilities.map(([name, cap]) =>
            cap.description
              ? `    ${snakeCase(name)}: ${cap.capability}\n    """${cap.description}"""`
              : `    ${snakeCase(name)}: ${cap.capability}`,
          ),
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

  capabilitiesSource(): string {
    const declarations = Object.values(CAPABILITIES).map((capability) => {
      const operations = capability.operations.map(operationSignature).join("\n");
      return `class ${capability.name}(Protocol):\n    """${capability.description}"""\n\n${operations}`;
    });

    return [
      `# Generated by Fragmentor. Do not edit.`,
      ``,
      `from __future__ import annotations`,
      ``,
      `from typing import Protocol`,
      ``,
      ``,
      declarations.join("\n\n\n"),
      ``,
    ].join("\n");
  },

  // Generating Python works; running it needs the module layout question
  // in STATUS.md settled first.
  canRun: false,
  isUnimplemented: (source) => source.includes(UNIMPLEMENTED),
};

registerPack(pythonPack);
