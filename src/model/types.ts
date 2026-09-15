import { z } from "zod/v4";

/**
 * The type language used to describe what flows through a port.
 *
 * This is deliberately smaller than TypeScript's type system. It has to serve
 * three masters at once: it is stored in block.json, it is compiled to a zod
 * schema for runtime checking, and it is rendered as an input form in the test
 * bench. A construct that cannot be drawn as a form control does not belong
 * here. Anything richer lives inside a leaf block's own code.
 */
export type PortType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "unknown" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; of: PortType }
  | { kind: "object"; fields: Record<string, ObjectField> }
  | { kind: "union"; of: PortType[] }
  /**
   * A type written as free text, as in visual mode, where the diagram
   * describes code Fragmentor never checks. It is shown, never enforced, and
   * the parser never produces it.
   */
  | { kind: "text"; text: string };

export interface ObjectField {
  type: PortType;
  optional?: boolean;
  description?: string;
}

/** Field and port names become object keys and variable names in generated code. */
export const identifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const identifier = z
  .string()
  .regex(identifierPattern, "must be a valid identifier (letters, digits, underscore; not starting with a digit)");

export const objectFieldSchema: z.ZodType<ObjectField> = z.lazy(() =>
  z
    .object({
      type: portTypeSchema,
      optional: z.boolean().optional(),
      description: z.string().optional(),
    })
    .strict(),
);

export const portTypeSchema: z.ZodType<PortType> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("string") }).strict(),
    z.object({ kind: z.literal("number") }).strict(),
    z.object({ kind: z.literal("boolean") }).strict(),
    z.object({ kind: z.literal("null") }).strict(),
    z.object({ kind: z.literal("unknown") }).strict(),
    z
      .object({
        kind: z.literal("literal"),
        value: z.union([z.string(), z.number(), z.boolean()]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("enum"),
        values: z.array(z.string()).min(1, "an enum needs at least one value"),
      })
      .strict(),
    z.object({ kind: z.literal("array"), of: portTypeSchema }).strict(),
    z
      .object({
        kind: z.literal("object"),
        fields: z.record(identifier, objectFieldSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("union"),
        of: z.array(portTypeSchema).min(2, "a union needs at least two members"),
      })
      .strict(),
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  ]),
) as z.ZodType<PortType>;

/**
 * A short human-readable rendering, used in diagrams, tooltips, and the
 * prompts the AI sees. Intentionally lossy: descriptions are omitted.
 */
export function describeType(type: PortType): string {
  switch (type.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      return type.kind;
    case "text":
      return type.text;
    case "literal":
      return typeof type.value === "string" ? JSON.stringify(type.value) : String(type.value);
    case "enum":
      return type.values.map((v) => JSON.stringify(v)).join(" | ");
    case "array": {
      // A union binds looser than `[]`, so without brackets an array of a
      // union would read back as a union ending in an array.
      const element = describeType(type.of);
      const needsBrackets =
        type.of.kind === "union" || (type.of.kind === "enum" && type.of.values.length > 1);
      return needsBrackets ? `(${element})[]` : `${element}[]`;
    }
    case "union":
      return type.of.map(describeType).join(" | ");
    case "object": {
      const entries = Object.entries(type.fields);
      if (entries.length === 0) return "{}";
      const body = entries
        .map(([name, field]) => `${name}${field.optional ? "?" : ""}: ${describeType(field.type)}`)
        .join("; ");
      return `{ ${body} }`;
    }
  }
}

/**
 * Structural equality, used to decide whether a contract change invalidates
 * the blocks that depend on it. Object field order is not significant.
 */
export function typesEqual(a: PortType, b: PortType): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      return true;
    case "text":
      return a.text === (b as typeof a).text;
    case "literal":
      return a.value === (b as typeof a).value;
    case "enum": {
      const other = b as typeof a;
      return a.values.length === other.values.length && a.values.every((v, i) => v === other.values[i]);
    }
    case "array":
      return typesEqual(a.of, (b as typeof a).of);
    case "union": {
      const other = b as typeof a;
      return a.of.length === other.of.length && a.of.every((t, i) => typesEqual(t, other.of[i]!));
    }
    case "object": {
      const other = b as typeof a;
      const aKeys = Object.keys(a.fields).sort();
      const bKeys = Object.keys(other.fields).sort();
      if (aKeys.length !== bKeys.length) return false;
      if (!aKeys.every((k, i) => k === bKeys[i])) return false;
      return aKeys.every((k) => {
        const fa = a.fields[k]!;
        const fb = other.fields[k]!;
        return Boolean(fa.optional) === Boolean(fb.optional) && typesEqual(fa.type, fb.type);
      });
    }
  }
}

/**
 * Checks a value against a port type, returning what is wrong with it.
 *
 * The test bench needs this to reject a bad input before running anything, and
 * to notice when a block returns something its contract does not allow. It is
 * deliberately independent of any language's validation library, because it
 * has to work the same for every language pack.
 */
export function checkValue(value: unknown, type: PortType, where = "value"): string[] {
  switch (type.kind) {
    case "unknown":
    case "text":
      return [];
    case "string":
      return typeof value === "string" ? [] : [`${where} should be a string, but it is ${describeValue(value)}.`];
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? []
        : [`${where} should be a number, but it is ${describeValue(value)}.`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${where} should be true or false, but it is ${describeValue(value)}.`];
    case "null":
      return value === null ? [] : [`${where} should be null, but it is ${describeValue(value)}.`];
    case "literal":
      return value === type.value ? [] : [`${where} should be ${JSON.stringify(type.value)}, but it is ${describeValue(value)}.`];
    case "enum":
      return typeof value === "string" && type.values.includes(value)
        ? []
        : [`${where} should be one of ${type.values.map((v) => JSON.stringify(v)).join(", ")}, but it is ${describeValue(value)}.`];
    case "array": {
      if (!Array.isArray(value)) return [`${where} should be a list, but it is ${describeValue(value)}.`];
      return value.flatMap((item, i) => checkValue(item, type.of, `${where}[${i}]`));
    }
    case "union": {
      if (type.of.some((member) => checkValue(value, member).length === 0)) return [];
      return [`${where} should be ${describeType(type)}, but it is ${describeValue(value)}.`];
    }
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [`${where} should be an object, but it is ${describeValue(value)}.`];
      }

      const record = value as Record<string, unknown>;
      const problems: string[] = [];

      for (const [name, field] of Object.entries(type.fields)) {
        if (!(name in record) || record[name] === undefined) {
          if (!field.optional) problems.push(`${where}.${name} is missing.`);
          continue;
        }
        problems.push(...checkValue(record[name], field.type, `${where}.${name}`));
      }

      for (const name of Object.keys(record)) {
        if (!(name in type.fields)) problems.push(`${where}.${name} is not part of this type.`);
      }

      return problems;
    }
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}
