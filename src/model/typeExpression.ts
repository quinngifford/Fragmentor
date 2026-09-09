import type { ObjectField, PortType } from "./types.js";
import { identifierPattern } from "./types.js";

/**
 * Parses the type syntax produced by `describeType` back into a PortType.
 *
 * Port types are stored as a JSON structure because the test bench needs to
 * walk them to build a form. But asking a model to emit deeply nested JSON for
 * every port is error-prone, and it is unpleasant to read in a diff. At the
 * AI boundary and in the UI, types are written the way a developer would write
 * them:
 *
 *   { title: string; salary?: number }[]
 *   "remote" | "hybrid" | "onsite"
 *
 * `describeType` and `parseType` are inverses, which is a property the tests
 * hold them to.
 */

type Token =
  | { kind: "identifier"; value: string; at: number }
  | { kind: "string"; value: string; at: number }
  | { kind: "number"; value: number; at: number }
  | { kind: "punct"; value: string; at: number };

const PUNCTUATION = new Set(["{", "}", "[", "]", "(", ")", ";", ",", ":", "?", "|"]);

class TypeSyntaxError extends Error {
  constructor(message: string, readonly source: string, readonly at: number) {
    super(`${message} (at position ${at} of \`${source}\`)`);
    this.name = "TypeSyntaxError";
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (PUNCTUATION.has(char)) {
      // `[]` is one postfix operator, but tokenizing the brackets separately
      // keeps the parser simple.
      tokens.push({ kind: "punct", value: char, at: i });
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\" && j + 1 < source.length) {
          value += source[j + 1];
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new TypeSyntaxError("Unterminated string", source, i);
      tokens.push({ kind: "string", value, at: i });
      i = j + 1;
      continue;
    }

    const numberMatch = /^-?\d+(\.\d+)?/.exec(source.slice(i));
    if (numberMatch) {
      tokens.push({ kind: "number", value: Number(numberMatch[0]), at: i });
      i += numberMatch[0].length;
      continue;
    }

    const identifierMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (identifierMatch) {
      tokens.push({ kind: "identifier", value: identifierMatch[0], at: i });
      i += identifierMatch[0].length;
      continue;
    }

    throw new TypeSyntaxError(`Unexpected character "${char}"`, source, i);
  }

  return tokens;
}

export function parseType(source: string): PortType {
  const tokens = tokenize(source);
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const at = (): number => peek()?.at ?? source.length;

  const eat = (value: string): boolean => {
    const token = peek();
    if (token?.kind === "punct" && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };

  const expect = (value: string): void => {
    if (!eat(value)) throw new TypeSyntaxError(`Expected "${value}"`, source, at());
  };

  const parseUnion = (): PortType => {
    const members = [parsePostfix()];
    while (eat("|")) members.push(parsePostfix());
    if (members.length === 1) return members[0]!;

    // A union written entirely from string literals is an enum. Canonicalising
    // here is what keeps describeType and parseType exact inverses.
    if (members.every((m) => m.kind === "literal" && typeof m.value === "string")) {
      return { kind: "enum", values: members.map((m) => (m as { value: string }).value) };
    }
    return { kind: "union", of: members };
  };

  const parsePostfix = (): PortType => {
    let type = parseAtom();
    for (;;) {
      const token = peek();
      if (token?.kind === "punct" && token.value === "[") {
        position += 1;
        expect("]");
        type = { kind: "array", of: type };
        continue;
      }
      return type;
    }
  };

  const parseAtom = (): PortType => {
    const token = peek();
    if (!token) throw new TypeSyntaxError("Expected a type", source, source.length);

    if (token.kind === "punct" && token.value === "(") {
      position += 1;
      const inner = parseUnion();
      expect(")");
      return inner;
    }

    if (token.kind === "punct" && token.value === "{") {
      position += 1;
      const fields: Record<string, ObjectField> = {};

      while (!eat("}")) {
        const nameToken = peek();
        if (!nameToken || (nameToken.kind !== "identifier" && nameToken.kind !== "string")) {
          throw new TypeSyntaxError("Expected a field name", source, at());
        }
        const name = String(nameToken.value);
        if (!identifierPattern.test(name)) {
          throw new TypeSyntaxError(`"${name}" is not usable as a field name`, source, nameToken.at);
        }
        if (name in fields) {
          throw new TypeSyntaxError(`Duplicate field "${name}"`, source, nameToken.at);
        }
        position += 1;

        const optional = eat("?");
        expect(":");
        const fieldType = parseUnion();

        fields[name] = optional ? { type: fieldType, optional: true } : { type: fieldType };

        // Separators are optional before the closing brace, and a comma is
        // accepted anywhere a semicolon is, because models write both.
        if (!eat(";") && !eat(",")) {
          if (eat("}")) return { kind: "object", fields };
          throw new TypeSyntaxError("Expected \";\" or \"}\" after a field", source, at());
        }
      }

      return { kind: "object", fields };
    }

    if (token.kind === "string") {
      position += 1;
      return { kind: "literal", value: token.value };
    }

    if (token.kind === "number") {
      position += 1;
      return { kind: "literal", value: token.value };
    }

    if (token.kind === "identifier") {
      position += 1;
      switch (token.value) {
        case "string":
        case "number":
        case "boolean":
        case "null":
        case "unknown":
          return { kind: token.value };
        case "true":
          return { kind: "literal", value: true };
        case "false":
          return { kind: "literal", value: false };
        default:
          throw new TypeSyntaxError(
            `Unknown type "${token.value}". Port types are built from string, number, boolean, null, unknown, literals, objects, and arrays.`,
            source,
            token.at,
          );
      }
    }

    throw new TypeSyntaxError("Expected a type", source, token.at);
  };

  const type = parseUnion();
  if (position !== tokens.length) {
    throw new TypeSyntaxError("Unexpected trailing text", source, at());
  }
  return type;
}

/** Parses without throwing, for use where a bad type is reported rather than fatal. */
export function tryParseType(source: string): { ok: true; type: PortType } | { ok: false; error: string } {
  try {
    return { ok: true, type: parseType(source) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
