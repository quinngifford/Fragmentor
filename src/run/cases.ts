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
  /**
   * What each store the block reaches holds before it runs, by target and
   * then by key. A block that reads one has to bring its rows with it, or the
   * case would only ever see an empty table.
   */
  stores?: Record<string, Record<string, unknown>>;
  /** Absent when the case has no expectation yet. */
  expected?: unknown;
}

const caseSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown(),
    stores: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
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

/**
 * A block's saved tests, and why they could not be read if they could not.
 * A missing file just means there are no tests yet. A broken one is reported,
 * because an agent writing tests by hand would otherwise watch them vanish.
 */
export async function readCases(
  projectDir: string,
  blockPath: string,
): Promise<{ cases: TestCase[]; problem: string | null }> {
  let text: string;
  try {
    text = await readFile(casesPath(projectDir, blockPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { cases: [], problem: null };
    const reason = error instanceof Error ? error.message : String(error);
    return { cases: [], problem: `Its tests could not be read: ${reason}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { cases: [], problem: `Its tests could not be read: cases.json is not valid JSON (${reason}).` };
  }

  const parsed = casesSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      cases: [],
      problem: `Its tests could not be read: cases.json should be a list of { "name", "input", "stores", "expected" } (${detail}).`,
    };
  }

  return { cases: parsed.data as TestCase[], problem: null };
}

/** A block's saved tests. A file that cannot be read should not stop a block being opened. */
export async function loadCases(projectDir: string, blockPath: string): Promise<TestCase[]> {
  return (await readCases(projectDir, blockPath)).cases;
}

export async function saveCases(projectDir: string, blockPath: string, cases: TestCase[]): Promise<void> {
  const parsed = casesSchema.safeParse(cases);
  if (!parsed.success) {
    throw new Error(`Those tests are not valid: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
  }

  const tidied = (parsed.data as TestCase[]).map((testCase) => ({
    name: testCase.name,
    input: testCase.input,
    ...(testCase.stores && Object.keys(testCase.stores).length > 0 ? { stores: testCase.stores } : {}),
    ...(hasExpectation(testCase) ? { expected: testCase.expected } : {}),
  }));

  await writeFile(casesPath(projectDir, blockPath), `${JSON.stringify(tidied, null, 2)}\n`, "utf8");
}
