import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { blockDir } from "../project/project.js";

/**
 * Saved tests for a block.
 *
 * They live in the block's own folder, next to its code and its contract, so a
 * block carries its tests with it: move the folder and the tests move too, and
 * a project shared as a repository brings them along.
 *
 * A test without an expected value still runs; it just reports what came back
 * rather than passing or failing. That makes saving a case worthwhile before
 * you know what the right answer is.
 */

export interface TestCase {
  name: string;
  input: unknown;
  /** Absent when the case has no expectation yet. */
  expected?: unknown;
}

const caseSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown(),
    expected: z.unknown().optional(),
  })
  .strict();

export const casesSchema = z.array(caseSchema);

const CASES_FILE = "cases.json";

export function casesPath(projectDir: string, blockPath: string): string {
  return path.join(blockDir(projectDir, blockPath), CASES_FILE);
}

export function hasExpectation(testCase: TestCase): boolean {
  return testCase.expected !== undefined;
}

export async function loadCases(projectDir: string, blockPath: string): Promise<TestCase[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(casesPath(projectDir, blockPath), "utf8"));
  } catch {
    return [];
  }

  const parsed = casesSchema.safeParse(raw);
  // A tests file that cannot be read should not stop a block being opened.
  return parsed.success ? (parsed.data as TestCase[]) : [];
}

export async function saveCases(projectDir: string, blockPath: string, cases: TestCase[]): Promise<void> {
  const parsed = casesSchema.safeParse(cases);
  if (!parsed.success) {
    throw new Error(`Those tests are not valid: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }

  const tidied = (parsed.data as TestCase[]).map((testCase) =>
    hasExpectation(testCase)
      ? { name: testCase.name, input: testCase.input, expected: testCase.expected }
      : { name: testCase.name, input: testCase.input },
  );

  await writeFile(casesPath(projectDir, blockPath), `${JSON.stringify(tidied, null, 2)}\n`, "utf8");
}
