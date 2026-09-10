/**
 * Comparing what a block returned against what a saved test expected.
 *
 * Reports every difference rather than the first, and says where each one is,
 * because "these do not match" is useless when the value is a list of objects.
 */

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `a list of ${value.length}`;
  return "an object";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compareValues(actual: unknown, expected: unknown, where = "output"): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${where} should be a list but was ${describe(actual)}.`];

    const differences: string[] = [];
    if (actual.length !== expected.length) {
      differences.push(`${where} has ${actual.length} items, expected ${expected.length}.`);
    }
    for (let i = 0; i < Math.min(actual.length, expected.length); i += 1) {
      differences.push(...compareValues(actual[i], expected[i], `${where}[${i}]`));
    }
    return differences;
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [`${where} should be an object but was ${describe(actual)}.`];

    const differences: string[] = [];
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) {
        differences.push(`${where}.${key} is missing.`);
        continue;
      }
      differences.push(...compareValues(actual[key], expected[key], `${where}.${key}`));
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) differences.push(`${where}.${key} was not expected.`);
    }
    return differences;
  }

  // Object.is so that NaN matches NaN, which strict equality would not.
  if (Object.is(actual, expected)) return [];
  return [`${where} was ${describe(actual)}, expected ${describe(expected)}.`];
}
