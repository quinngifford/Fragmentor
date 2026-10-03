import type { Block } from "../model/block.js";
import { CAPABILITIES } from "../model/capabilities.js";
import type { CapabilityDefinition, CapabilityOperation } from "../model/capabilities.js";
import type { PortType } from "../model/types.js";
import { pascalCase, snakeCase } from "./naming.js";
import { registerPack } from "./pack.js";
import type { ContractRequest, LanguagePack } from "./pack.js";

/**
 * Python, as plain typed dictionaries.
 *
 * A contract is TypedDicts and a Protocol, imported for types only under
 * `if TYPE_CHECKING:`, so a run needs neither the contract nor anything
 * installed: the values crossing a block's edge are already validated in Node
 * against block.json. TypedDict keys are the port and field names exactly as
 * the diagram writes them, so the data an agent reads in Python is the data
 * the diagram shows; a key Python reserves, such as `class`, uses the
 * functional form.
 *
 * Python cannot import through a hyphenated folder, so contracts live in an
 * importable mirror, `blocks/_contracts/<path with - as _>/contract.py`,
 * rather than in the block's own folder the way TypeScript's do.
 */

/** Python's reserved words, as `keyword.iskeyword` has them in 3.11. */
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const isIdentifier = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PYTHON_KEYWORDS.has(name);

/**
 * The names a contract's own lines need: importing them, or writing an
 * annotation with them. A capability port with one of these names would bind
 * over it inside the Caps class before later annotations are evaluated.
 */
const CONTRACT_NAMES = new Set(["Any", "Literal", "NotRequired", "Protocol", "TypeAlias", "TypedDict", "list", ...Object.keys(CAPABILITIES)]);

/**
 * Text as a docstring holds it. A backslash would start an escape — `\U` in a
 * Windows path is a syntax error, not a character — and an unguarded quote
 * could end the string early.
 */
const docstring = (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * A block id as a segment of the contract mirror: hyphens become underscores,
 * and an id that is itself a reserved word gets a trailing underscore. Ids
 * hold no underscores of their own, so no two ids meet in one segment.
 */
function segment(id: string): string {
  const underscored = id.replace(/-/g, "_");
  return PYTHON_KEYWORDS.has(underscored) ? `${underscored}_` : underscored;
}

interface DeclarationSink {
  declarations: string[];
}

/** One TypedDict, in the class form, or the functional form when a key is a reserved word. */
function typedDict(name: string, fields: [key: string, annotation: string, optional: boolean][]): string {
  if (fields.length === 0) return `class ${name}(TypedDict):\n    pass`;
  const wrapped = (annotation: string, optional: boolean) => (optional ? `NotRequired[${annotation}]` : annotation);
  if (fields.some(([key]) => !isIdentifier(key))) {
    const items = fields.map(([key, annotation, optional]) => `'${key}': ${wrapped(annotation, optional)}`).join(", ");
    return `${name} = TypedDict('${name}', {${items}})`;
  }
  return `class ${name}(TypedDict):\n${fields.map(([key, annotation, optional]) => `    ${key}: ${wrapped(annotation, optional)}`).join("\n")}`;
}

/**
 * Renders a port type as a Python annotation, declaring a TypedDict for every
 * object it contains. `hint` seeds the names of those dictionaries.
 */
function annotation(type: PortType, hint: string, sink: DeclarationSink): string {
  switch (type.kind) {
    case "string":
      return "str";
    case "number":
      // Fragmentor has one number type; Python accepts an int where a float
      // is annotated, so this is wider than TypeScript rather than narrower.
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
      const fields = Object.entries(type.fields).map(([name, field]): [string, string, boolean] => [
        name,
        annotation(field.type, hint + pascalCase(snakeCase(name).replace(/_/g, "-")), sink),
        field.optional === true,
      ]);
      sink.declarations.push(typedDict(hint, fields));
      return hint;
    }
  }
}

/** A block's ports as the dictionary its code is handed, or hands back. */
function portsDict(name: string, ports: Block["inputs"], sink: DeclarationSink): string {
  const fields = Object.entries(ports).map(([portName, port]): [string, string, boolean] => [
    portName,
    annotation(port.type, name + pascalCase(portName.replace(/_/g, "-")), sink),
    false,
  ]);
  return typedDict(name, fields);
}

/**
 * A type in a capability's signature. The capability's own parameter is
 * written as free text in the catalogue, which every other pack renders
 * verbatim; here it has to survive as the TypeVar rather than collapse to
 * `Any` the way free text otherwise does. Arrays are `builtins.list` because
 * a capability may have an operation called `list`, which would shadow the
 * built-in inside its own class.
 */
function capabilityAnnotation(type: PortType, parameter: string | undefined): string {
  if (parameter !== undefined && type.kind === "text" && type.text === parameter) return parameter;
  if (type.kind === "array") return `builtins.list[${capabilityAnnotation(type.of, parameter)}]`;
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

/**
 * Whether a capability's parameter may vary contravariantly: nothing gives it
 * back, so a callee accepting a wider one is safe. A queue's message is such a
 * parameter, and without it a caller could not pass its whole caps to a callee
 * whose channel takes a narrower message.
 */
function contravariant(definition: CapabilityDefinition): boolean {
  const mentions = (type: PortType): boolean => {
    if (type.kind === "text") return type.text === definition.parameter;
    if (type.kind === "array") return mentions(type.of);
    if (type.kind === "union") return type.of.some(mentions);
    return false;
  };
  return !definition.operations.some((operation) => operation.returns !== null && mentions(operation.returns));
}

export const pythonPack: LanguagePack = {
  id: "python",
  displayName: "Python",
  contractPath: (blockPath) => `blocks/_contracts/${blockPath.split("/").map(segment).join("/")}/contract.py`,
  capabilitiesFile: "capabilities.py",

  functionName: (blockId) => snakeCase(blockId),
  typeName: (blockId, role) => `${pascalCase(blockId)}${role}`,
  typeExpression: (type) => annotation(type, "Value", { declarations: [] }),

  contractSource({ block, bound }: ContractRequest): string {
    const sink: DeclarationSink = { declarations: [] };
    const inputName = this.typeName(block.id, "Input");
    const outputName = this.typeName(block.id, "Output");
    const capsName = this.typeName(block.id, "Caps");

    const capabilities = Object.entries(block.capabilities);
    const capabilityTypes = [...new Set(capabilities.map(([, cap]) => cap.capability))].sort();

    const capsLines =
      capabilities.length === 0
        ? [`class ${capsName}(Protocol):`, `    """${docstring(block.name)} needs no effects supplied from outside."""`].join("\n")
        : [
            `class ${capsName}(Protocol):`,
            ...capabilities.map(([name, cap]) => {
              // A parameterised capability is written in terms of what it is a
              // way into, whose shape becomes a TypedDict like any other. The
              // Row suffix keeps its name apart from the Input, Output and
              // Caps declarations, whatever the port is called.
              const parameter = CAPABILITIES[cap.capability]?.parameter;
              const row = parameter ? bound?.[name] : undefined;
              const type = parameter
                ? `${cap.capability}[${row ? annotation(row, `${pascalCase(block.id)}${pascalCase(snakeCase(name).replace(/_/g, "-"))}Row`, sink) : "Any"}]`
                : cap.capability;
              return cap.description
                ? `    @property\n    def ${name}(self) -> ${type}:\n        """${docstring(cap.description)}"""\n        ...`
                : `    @property\n    def ${name}(self) -> ${type}: ...`;
            }),
          ].join("\n");

    const inputDict = portsDict(inputName, block.inputs, sink);
    // Nothing to return is None, so the block's code returns nothing rather
    // than an empty dictionary nobody asked for.
    const outputDict =
      Object.keys(block.outputs).length === 0
        ? `${outputName}: TypeAlias = None`
        : portsDict(outputName, block.outputs, sink);

    // No `from __future__ import annotations` here: everything is declared
    // before it is used, and postponed annotations would stop TypedDict from
    // seeing NotRequired at run time on Pythons before 3.13.
    const header = [
      `# Generated by Fragmentor from block.json. Do not edit.`,
      `# ${block.name}: ${block.responsibility}`,
      ``,
      `from typing import Any, Literal, NotRequired, Protocol, TypeAlias, TypedDict`,
    ];
    if (capabilityTypes.length > 0) {
      header.push(``, `from blocks.capabilities import ${capabilityTypes.join(", ")}`);
    }

    // Nested dictionaries have to be declared before the ones that use them.
    const body = [...sink.declarations, inputDict, outputDict, capsLines];

    return `${[...header, ``, ``, body.join("\n\n\n")].join("\n")}\n`;
  },

  capabilitiesSource(): string {
    const parameterised = Object.values(CAPABILITIES).filter(
      (each): each is CapabilityDefinition & { parameter: string } => each.parameter !== undefined,
    );
    const typeVars = [
      ...new Map(
        parameterised.map((each) => [
          each.parameter,
          `${each.parameter} = TypeVar("${each.parameter}"${contravariant(each) ? ", contravariant=True" : ""})`,
        ]),
      ).values(),
    ];

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
      `import builtins`,
      `from typing import Generic, Protocol, TypeVar`,
      ``,
      ``,
      ...(typeVars.length > 0 ? [typeVars.join("\n"), ``, ``] : []),
      declarations.join("\n\n\n"),
      ``,
    ].join("\n");
  },

  // The dotted name of the contract's module, imported from the project root,
  // which is how one Python file reaches another whatever folder it is in.
  contractSpecifier: (contractPath) => contractPath.replace(/[.]py$/, "").split("/").join("."),

  codeFileProblem: (file) => {
    if (!file.endsWith(".py")) {
      return `Python cannot import ${file}, because only a .py file can be imported, so Fragmentor draws this code as it stands`;
    }
    const bad = file.slice(0, -3).split("/").find((each) => !isIdentifier(each));
    return bad === undefined
      ? null
      : `Python cannot import ${file}, because "${bad}" cannot be part of a module's name, so Fragmentor draws this code as it stands`;
  },

  contractProblem: (block) => {
    const reserved = Object.keys(block.capabilities).find((name) => PYTHON_KEYWORDS.has(name));
    if (reserved !== undefined) {
      return `its capability port "${reserved}" is a word Python reserves, so no contract can be written for it; rename the port`;
    }
    const shadowing = Object.keys(block.capabilities).find((name) => CONTRACT_NAMES.has(name));
    return shadowing === undefined
      ? null
      : `its capability port "${shadowing}" is a name the contract itself needs, so no contract can be written for it; rename the port`;
  },
};

registerPack(pythonPack);
