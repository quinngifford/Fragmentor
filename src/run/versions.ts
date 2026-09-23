import { copyFile, cp, lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyPlan, noise, planSwap, pointerPath, under } from "../project/history.js";
import { loadProject } from "../project/project.js";
import type { Project } from "../project/project.js";
import { readCases } from "./cases.js";
import type { TestCase } from "./cases.js";
import { compareValues } from "./compare.js";
import { runManyCases } from "./run.js";
import type { CaseResult } from "./run.js";

/**
 * Comparing a block with one of its versions, by running tests against both.
 *
 * One list of tests runs against both: every test saved for the block now,
 * and every test only the version had. A test saved in both runs as it is
 * saved now. Running one definition against both versions is what turns a
 * difference into a verdict; if each ran its own, both would simply pass.
 *
 * Each version runs in a copy of the project of its own: today's as it is,
 * and the version with exactly what a swap would write put in place, so the
 * comparison shows what swapping would do. What the tests write stays in
 * their copy, so neither version sees the other's writes, and nothing is
 * ever written into the project. A file a copy does not hold, such as data a
 * test reads, is read from the project itself. That is the one way a
 * comparison can be inexact: a file the version did not have, but the
 * project has now, can still be read by the version's tests.
 *
 * And every other saved test in the block's system runs too, because a swap
 * can change or break a block outside it that calls its code, and nothing
 * about the swap itself can see that.
 */

export interface ComparedTest {
  name: string;
  /**
   * Which versions saved it. Where one version's tests could not be read,
   * nothing is known about which tests it had, so a test counts as saved in
   * both rather than as new or no longer saved.
   */
  saved: "both" | "now" | "then";
  /** Saved in both, with a different input, stores or expected value. */
  redefined: boolean;
  /** Null when the block is not in that version. */
  now: CaseResult | null;
  then: CaseResult | null;
  /** Whether it comes out differently in the two versions. */
  differs: boolean;
}

export interface ComparedBlock {
  blockPath: string;
  name: string;
  tests: ComparedTest[];
  /** Why its saved tests could not be read in each version, or null where they could. */
  unreadable: { now: string | null; then: string | null };
}

export interface VersionComparison {
  /** The name of the system's root block. */
  system: string;
  /** The block and its parts that have saved tests, with every test. */
  inside: ComparedBlock[];
  /** Other blocks of the system, with only the tests that come out differently, or whose tests could not be read. */
  outside: ComparedBlock[];
  /** How many tests of other blocks ran. */
  othersRun: number;
}

/** How a test came out, in the terms two versions are compared in. A test that no longer fits the block's inputs is its own outcome. */
function outcome(result: CaseResult | null): string {
  if (result === null) return "absent";
  if (result.status === "error" && result.inputProblems.length > 0) return "does not fit";
  return result.status;
}

/** Everything a test says, apart from its name. */
const definition = (testCase: TestCase) => ({ input: testCase.input, stores: testCase.stores ?? {}, expected: testCase.expected });

/** A block's saved tests in one version, and why they could not be read, if they could not. */
async function testsIn(project: Project, dir: string, blockPath: string): Promise<{ cases: TestCase[]; unreadable: string | null }> {
  if (!project.byPath.has(blockPath)) return { cases: [], unreadable: null };
  const read = await readCases(dir, blockPath);
  // readCases says "Its tests could not be read"; the window says which version.
  return { cases: read.cases, unreadable: read.problem?.replace(/^Its tests could not be read: /, "") ?? null };
}

export async function compareWithVersion(projectDir: string, blockPath: string, commit: string): Promise<VersionComparison> {
  const plan = await planSwap(projectDir, blockPath, commit);
  const live = plan.project;

  const copies = await mkdtemp(path.join(tmpdir(), "fragmentor-compare-"));
  try {
    // A run needs the manifest, the blocks, and the code the blocks point at.
    // Nothing else is copied: the rest is read from the project, and its
    // installed packages found, through `copyOf`. A link is never copied, so
    // nothing done in a copy can reach through one.
    const nowDir = path.join(copies, "now");
    const thenDir = path.join(copies, "then");
    await mkdir(nowDir);
    await copyFile(path.join(projectDir, "fragmentor.json"), path.join(nowDir, "fragmentor.json"));
    await cp(path.join(projectDir, "blocks"), path.join(nowDir, "blocks"), {
      recursive: true,
      filter: async (source) => !noise(path.relative(projectDir, source)) && !(await lstat(source)).isSymbolicLink(),
    });
    for (const node of live.byPath.values()) {
      const pointer = pointerPath(node.block.code, node.block.planned);
      if (pointer === null) continue;
      const from = path.join(projectDir, ...pointer.split("/"));
      // A folder is only ever pointed at by a block Fragmentor never runs.
      if (!(await stat(from).then((info) => info.isFile(), () => false))) continue;
      const to = path.join(nowDir, ...pointer.split("/"));
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    await cp(nowDir, thenDir, { recursive: true });
    // Contracts are imported as types, which vanish when the code is compiled
    // to run, so nothing needs generating in the copy.
    await applyPlan(thenDir, new Map(plan.touched.map((file) => [file, plan.then.get(file) ?? null])));

    const then = await loadProject(thenDir);
    const system = blockPath.split("/")[0]!;
    const paths = [...live.byPath.keys(), ...[...then.byPath.keys()].filter((each) => !live.byPath.has(each))].filter(
      (each) => each.split("/")[0] === system,
    );

    // Each block's list of tests. A block whose tests could not be read is
    // kept even with none, so the window can say so.
    const read = await Promise.all(
      paths.map(async (each) => {
        const nowRead = await testsIn(live, projectDir, each);
        const thenRead = await testsIn(then, thenDir, each);
        const savedNow = new Set(nowRead.cases.map((testCase) => testCase.name));
        const list = [...nowRead.cases, ...thenRead.cases.filter((testCase) => !savedNow.has(testCase.name))];
        return { blockPath: each, list, savedNow, thenCases: thenRead.cases, unreadable: { now: nowRead.unreadable, then: thenRead.unreadable } };
      }),
    );
    const blocks = read.filter((block) => block.list.length > 0 || block.unreadable.now !== null || block.unreadable.then !== null);

    // Each version is compiled once and runs every block's list. The two
    // share no written files, so they run at the same time, and both are
    // waited for even when one fails, so no copy is taken away under a run.
    const listsIn = (project: Project) =>
      new Map(blocks.filter((block) => project.byPath.has(block.blockPath)).map((block) => [block.blockPath, block.list]));
    const [ranNow, ranThen] = await Promise.allSettled([
      runManyCases(nowDir, listsIn(live), { copyOf: projectDir }),
      runManyCases(thenDir, listsIn(then), { copyOf: projectDir }),
    ]);
    if (ranNow.status === "rejected") throw ranNow.reason;
    if (ranThen.status === "rejected") throw ranThen.reason;

    const inside: ComparedBlock[] = [];
    const outside: ComparedBlock[] = [];
    let othersRun = 0;
    for (const { blockPath: each, list, savedNow, thenCases, unreadable } of blocks) {
      const tests = list.map((testCase, i): ComparedTest => {
        const before = thenCases.find((other) => other.name === testCase.name);
        const inNow = savedNow.has(testCase.name) || unreadable.now !== null;
        const inThen = before !== undefined || unreadable.then !== null;
        const now = ranNow.value.get(each)?.[i] ?? null;
        const was = ranThen.value.get(each)?.[i] ?? null;
        return {
          name: testCase.name,
          saved: inNow && inThen ? "both" : inNow ? "now" : "then",
          redefined:
            savedNow.has(testCase.name) && before !== undefined && compareValues(definition(testCase), definition(before)).length > 0,
          now,
          then: was,
          differs: outcome(now) !== outcome(was),
        };
      });

      const block = { blockPath: each, name: (live.byPath.get(each) ?? then.byPath.get(each))!.block.name, tests, unreadable };
      if (under(blockPath, each)) {
        inside.push(block);
      } else {
        othersRun += list.length;
        const differing = tests.filter((test) => test.differs);
        if (differing.length > 0 || unreadable.now !== null || unreadable.then !== null) outside.push({ ...block, tests: differing });
      }
    }

    const root = live.systems.find((each) => each.rootBlock === system);
    return { system: root?.root.block.name ?? system, inside, outside, othersRun };
  } finally {
    await rm(copies, { recursive: true, force: true });
  }
}
