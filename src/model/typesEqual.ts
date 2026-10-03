import type { PortType } from "./types.js";

/*
 * Kept apart from types.ts, which needs zod to read block.json, so the window
 * can compare two types without loading it.
 */

/** Structural equality of two port types. Object field order is not significant. */
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
