import type { PortType } from "../../src/model/types.js";
import type { SnapshotBlock, SnapshotStore } from "../../src/project/snapshot.js";
import type { TestCase } from "../../src/run/cases.js";
import type { CaseResult, RunOutcome, StoreEffect, StoreSeeds } from "../../src/run/run.js";
import { requireSnapshot, ui } from "./state.js";
import { runWatched, watchSection } from "./watch.js";
import { el, section, subsection } from "./dom.js";
import { codeBlock, typeLine } from "./highlight.js";
import { flagOffer } from "./notes.js";

/**
 * The test bench: enter values, run the block, see what came back.
 *
 * The form is built from the block's port types, so it always matches the
 * contract rather than being written separately and drifting from it. What is
 * typed is kept per block, because running redraws the panel and losing the
 * values every time would make the bench useless.
 *
 * Every run from here is watched: the diagram plays back what each block
 * received and returned, and stops at any breakpoint on the way.
 */

let notify: () => void = () => {};
export function onBenchChange(callback: () => void): void {
  notify = callback;
}

/** A value of this type that a person can sensibly start from. */
export function exampleFor(type: PortType, name?: string): unknown {
  switch (type.kind) {
    case "string":
      return name && /path/i.test(name) ? "postings.json" : "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
    case "unknown":
    case "text":
      return null;
    case "literal":
      return type.value;
    case "enum":
      return type.values[0];
    case "array":
      return [];
    case "union":
      return exampleFor(type.of[0]!, name);
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [field, spec] of Object.entries(type.fields)) {
        if (!spec.optional) out[field] = exampleFor(spec.type, field);
      }
      return out;
    }
  }
}

type Draft = Record<string, unknown>;

function readAt(draft: Draft, path: string[]): unknown {
  let cursor: unknown = draft;
  for (const step of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  return cursor;
}

function writeAt(draft: Draft, path: string[], value: unknown): void {
  let cursor = draft as Record<string, unknown>;
  for (const step of path.slice(0, -1)) {
    const next = cursor[step];
    if (next === null || typeof next !== "object") cursor[step] = {};
    cursor = cursor[step] as Record<string, unknown>;
  }
  cursor[path.at(-1)!] = value;
}

function labelled(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = el("div", "field");
  wrap.append(el("label", undefined, labelText), control);
  return wrap;
}

/** Builds a control that writes straight into the block's draft input. */
function controlFor(type: PortType, label: string, path: string[], draft: Draft): HTMLElement {
  const current = readAt(draft, path);

  if (type.kind === "object") {
    const group = el("div", "subfields");
    for (const [name, spec] of Object.entries(type.fields)) {
      group.append(controlFor(spec.type, name + (spec.optional ? "?" : ""), [...path, name], draft));
    }
    return labelled(label, group);
  }

  if (type.kind === "array" || type.kind === "unknown" || type.kind === "union") {
    const area = el("textarea");
    area.spellcheck = false;
    area.value = JSON.stringify(current ?? exampleFor(type), null, 1);

    const problem = el("p", "bench-note");
    area.addEventListener("input", () => {
      try {
        writeAt(draft, path, JSON.parse(area.value));
        delete area.dataset.invalid;
        problem.textContent = "";
      } catch {
        area.dataset.invalid = "true";
        problem.textContent = "Not valid JSON yet.";
      }
    });

    const wrap = labelled(label, area);
    wrap.append(problem);
    return wrap;
  }

  if (type.kind === "boolean") {
    const box = el("input");
    box.type = "checkbox";
    box.checked = current === true;
    box.addEventListener("change", () => writeAt(draft, path, box.checked));
    return labelled(label, box);
  }

  if (type.kind === "enum") {
    const select = el("select");
    for (const value of type.values) {
      const option = el("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = typeof current === "string" ? current : (type.values[0] ?? "");
    select.addEventListener("change", () => writeAt(draft, path, select.value));
    return labelled(label, select);
  }

  const input = el("input");
  input.type = type.kind === "number" ? "number" : "text";
  input.value = current === null || current === undefined ? "" : String(current);
  input.addEventListener("input", () => {
    writeAt(draft, path, type.kind === "number" ? Number(input.value) : input.value);
  });
  return labelled(label, input);
}

function draftFor(block: SnapshotBlock): Draft {
  const existing = ui.benchInputs.get(block.path);
  if (existing) return existing;

  const seeded: Draft = {};
  for (const port of block.inputs) seeded[port.name] = exampleFor(port.typeIr, port.name);
  ui.benchInputs.set(block.path, seeded);
  return seeded;
}

/**
 * What this block's bench will put in each store it reaches before it runs.
 *
 * A block whose job is reading a table cannot be tried out against an empty
 * one, so the rows belong with the input rather than somewhere else: they are
 * as much a part of "what this run starts from" as the values in the form.
 */
function storesFor(block: SnapshotBlock): StoreSeeds {
  const existing = ui.benchStores.get(block.path);
  if (existing) return existing;

  const seeded: StoreSeeds = {};
  for (const store of block.stores) if (store.seedable) seeded[store.target] = {};
  ui.benchStores.set(block.path, seeded);
  return seeded;
}

/**
 * Somewhere to put the rows a run will read, one store at a time.
 *
 * A store is keyed, and what the key means is the store's business rather
 * than Fragmentor's, so the rows are typed in as an object of key to row
 * instead of being built field by field the way an input is. The shape is
 * shown above the box, because it is what the run will hold the rows to.
 */
function storesForm(block: SnapshotBlock): HTMLElement | null {
  const seedable = block.stores.filter((store) => store.seedable);
  if (seedable.length === 0) return null;

  const node = subsection("What the stores hold before it runs");
  const seeds = storesFor(block);

  for (const store of seedable) {
    const area = el("textarea");
    area.spellcheck = false;
    area.value = JSON.stringify(seeds[store.target] ?? {}, null, 1);

    const problem = el("p", "bench-note");
    area.addEventListener("input", () => {
      try {
        const parsed: unknown = JSON.parse(area.value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("rows are given by key");
        }
        seeds[store.target] = parsed as Record<string, unknown>;
        delete area.dataset.invalid;
        problem.textContent = "";
      } catch {
        area.dataset.invalid = "true";
        problem.textContent = `Write the rows by key, as { "acc-1": … }.`;
      }
    });

    const wrap = labelled(`${store.resourceName} · ${store.entry}`, area);
    if (store.shape) {
      const shape = el("div", "pdesc pshape");
      shape.append(el("span", "pshape-label", "each row"), typeLine(store.shape));
      wrap.append(shape);
    }
    wrap.append(problem);
    node.append(wrap);
  }

  return node;
}

/** What the run left in the stores it touched, which for some blocks is the whole result. */
function storeEffects(block: SnapshotBlock, outcome: RunOutcome): HTMLElement | null {
  const touched = block.stores
    .map((store) => ({ store, effect: outcome.stores[store.target] }))
    .filter((each): each is { store: SnapshotStore; effect: StoreEffect } => each.effect !== undefined);
  if (touched.length === 0) return null;

  const node = subsection("What the stores hold now");
  for (const { store, effect } of touched) {
    const what = effect.kind === "queue" ? effect.sent : effect.rows;
    const count = effect.kind === "queue" ? effect.sent.length : Object.keys(effect.rows).length;
    const noun = effect.kind === "queue" ? "message" : "row";

    node.append(
      el("div", "pname", `${store.resourceName} · ${store.entry}`),
      el("div", "pdesc", `${count} ${noun}${count === 1 ? "" : "s"}${effect.kind === "queue" ? " sent" : ""}`),
      codeBlock(JSON.stringify(what, null, 2), "json"),
    );
  }
  return node;
}

function problemList(title: string, problems: string[], tone: string): HTMLElement {
  const wrap = subsection(title, tone);
  wrap.classList.add("run-problems");
  const list = el("ul");
  for (const problem of problems) list.append(el("li", undefined, problem));
  wrap.append(list);
  return wrap;
}

function resultPanel(block: SnapshotBlock): HTMLElement | null {
  if (ui.running.has(block.path)) return el("p", "bench-note", "Running…");

  const outcome = ui.runs.get(block.path);
  if (!outcome) return null;

  const panel = el("div", "run-result");

  if (outcome.inputProblems.length > 0) {
    panel.append(problemList("These values were refused, so nothing ran", outcome.inputProblems, "bad"));
    return panel;
  }

  if (!outcome.ok) {
    panel.append(problemList(outcome.stopped ? "The run was stopped" : "The block failed", [outcome.error ?? "No reason given."], "bad"));
  } else {
    const output = subsection(`Output — ${outcome.durationMs} ms`, "good");
    output.append(codeBlock(JSON.stringify(outcome.output, null, 2) ?? "nothing", "json"));
    panel.append(output);
  }

  if (outcome.outputProblems.length > 0) {
    panel.append(problemList("The result does not match what this block promises", outcome.outputProblems, "bad"));
  }

  // A block that failed, or broke its promise, is something to fix, and the
  // agent is who fixes it. A run the person stopped, or values the block
  // refused, say nothing about the code.
  const ran = ui.ranWith.get(block.path);
  if (ran && !outcome.stopped && (!outcome.ok || outcome.outputProblems.length > 0)) {
    panel.append(
      flagOffer(
        block,
        {
          test: null,
          input: ran.input,
          stores: ran.stores,
          ...(outcome.ok ? { output: outcome.output } : {}),
          problems: outcome.ok ? outcome.outputProblems : [outcome.error ?? "The block failed, and gave no reason."],
          logs: outcome.logs,
        },
        outcome,
      ),
    );
  }

  const effects = storeEffects(block, outcome);
  if (effects) panel.append(effects);

  if (outcome.logs.length > 0) {
    const logged = subsection("Logged");
    logged.append(el("pre", "code", outcome.logs.join("\n")));
    panel.append(logged);
  }

  return panel;
}

/** Whether the bench can run this block at all, and if not, why not. */
function whyNotRunnable(block: SnapshotBlock): string | null {
  if (!block.implemented) return "This block has no implementation yet, so there is nothing to run.";
  if (!block.runnable) return block.drawnBecause ?? "Fragmentor does not run this block.";
  return null;
}

/** Runs a block from the bench, with the diagram following the run. */
async function runFromBench(block: SnapshotBlock, input: unknown, stores: StoreSeeds): Promise<void> {
  ui.running.add(block.path);
  ui.runs.delete(block.path);
  ui.ranWith.set(block.path, { input: structuredClone(input), stores: structuredClone(stores) });
  notify();

  const result = await runWatched(block, input, stores);
  ui.running.delete(block.path);

  if (!result.ok) {
    ui.status = { text: `Could not run ${block.path}: ${result.error}`, tone: "bad" };
  } else {
    ui.runs.set(block.path, result.value);
    ui.status = result.value.ok
      ? { text: `${block.name} ran in ${result.value.durationMs} ms.`, tone: "good" }
      : { text: result.value.stopped ? `${block.name} was stopped.` : `${block.name} did not finish.`, tone: "bad" };
  }
  notify();
}

/* -------------------------------------------------------------------------- */
/* Saved tests                                                                 */
/* -------------------------------------------------------------------------- */

async function writeCases(block: SnapshotBlock, cases: TestCase[]): Promise<void> {
  const result = await window.fragmentor.saveCases({
    dir: requireSnapshot().dir,
    blockPath: block.path,
    cases,
  });

  if (!result.ok) {
    ui.status = { text: `Could not save the tests: ${result.error}`, tone: "bad" };
  } else {
    block.cases = cases;
    ui.status = { text: `Saved ${cases.length} test${cases.length === 1 ? "" : "s"} for ${block.name}.`, tone: "good" };
  }
  notify();
}

export function statusWord(status: CaseResult["status"]): string {
  return status === "unchecked" ? "no expectation" : status;
}

function caseRow(block: SnapshotBlock, testCase: TestCase, result: CaseResult | undefined): HTMLElement {
  const row = el("div", "case-row");
  row.append(el("div", "case-name", testCase.name));

  if (result) row.append(el("div", `case-status ${result.status}`, statusWord(result.status)));
  else if (testCase.expected === undefined) row.append(el("div", "case-status unchecked", "no expectation"));

  const actions = el("div", "case-actions");

  const watch = el("button", undefined, "Watch");
  watch.title = "Run this test's input with the diagram following along.";
  watch.disabled = whyNotRunnable(block) !== null || ui.running.has(block.path);
  watch.addEventListener("click", () => {
    const input = structuredClone(testCase.input) as Draft;
    const stores = structuredClone(testCase.stores ?? {});
    ui.benchInputs.set(block.path, input);
    ui.benchStores.set(block.path, stores);
    void runFromBench(block, structuredClone(input), structuredClone(stores));
  });

  const load = el("button", undefined, "Load");
  load.title = "Put this test's input into the form above.";
  load.addEventListener("click", () => {
    ui.benchInputs.set(block.path, structuredClone(testCase.input) as Draft);
    ui.benchStores.set(block.path, structuredClone(testCase.stores ?? {}));
    ui.status = { text: `Loaded "${testCase.name}".`, tone: "info" };
    notify();
  });

  const remove = el("button", undefined, "Delete");
  remove.addEventListener("click", () => {
    void writeCases(block, block.cases.filter((entry) => entry.name !== testCase.name));
  });

  actions.append(watch, load, remove);
  row.append(actions);
  return row;
}

function newCaseBox(block: SnapshotBlock): HTMLElement {
  const box = subsection("Save the current values as a test");
  box.classList.add("case-new");

  const lastRun = ui.runs.get(block.path);
  const canExpect = Boolean(lastRun?.ok);

  const nameField = el("input");
  nameField.type = "text";
  nameField.placeholder = "Name this test";
  nameField.value = ui.caseNames.get(block.path) ?? "";
  nameField.addEventListener("input", () => ui.caseNames.set(block.path, nameField.value));

  const expectBox = el("input");
  expectBox.type = "checkbox";
  expectBox.id = `expect-${block.path}`;
  expectBox.checked = canExpect;
  expectBox.disabled = !canExpect;

  const expectLabel = el(
    "label",
    undefined,
    canExpect ? "Expect the output it just produced" : "Run the block first to record an expected output",
  );
  expectLabel.htmlFor = expectBox.id;

  const save = el("button", "btn quiet", "Save");
  save.addEventListener("click", () => {
    const name = nameField.value.trim();
    if (!name) {
      ui.status = { text: "Give the test a name first.", tone: "bad" };
      notify();
      return;
    }

    const draft = structuredClone(draftFor(block)) as unknown;
    // The rows travel with the case: without them it would run against an
    // empty store and fail for a reason that has nothing to do with the code.
    const seeded = structuredClone(storesFor(block));
    const testCase: TestCase = {
      name,
      input: draft,
      ...(Object.values(seeded).some((rows) => Object.keys(rows).length > 0) ? { stores: seeded } : {}),
      ...(expectBox.checked && lastRun?.ok ? { expected: structuredClone(lastRun.output) } : {}),
    };

    // Saving under an existing name replaces that test rather than adding a
    // second one with the same name, which nothing could tell apart.
    const kept = block.cases.filter((entry) => entry.name !== name);
    ui.caseNames.set(block.path, "");
    void writeCases(block, [...kept, testCase]);
  });

  const row = el("div", "case-new-row");
  row.append(nameField, save);

  const expect = el("div", "case-expect");
  expect.append(expectBox, expectLabel);

  box.append(row, expect);
  return box;
}

/**
 * The tests as they were when each set of results was run, so a test flagged
 * for the agent carries the input and expectation that failed, even after the
 * agent has changed it since.
 */
const ranAs = new WeakMap<CaseResult[], TestCase[]>();

function casesSection(block: SnapshotBlock): HTMLElement {
  const node = section("Saved tests");

  const results = ui.caseResults.get(block.path);
  const byName = new Map((results ?? []).map((result) => [result.name, result]));

  if (block.cases.length === 0) {
    node.append(el("p", "bench-note", "No tests saved yet."));
  } else {
    const list = el("div", "cases");
    for (const testCase of block.cases) list.append(caseRow(block, testCase, byName.get(testCase.name)));
    node.append(list);

    const runAll = el("button", "btn", "Run all tests");
    runAll.disabled = ui.runningCases.has(block.path) || !block.implemented;
    runAll.addEventListener("click", () => {
      void (async () => {
        ui.runningCases.add(block.path);
        ui.caseResults.delete(block.path);
        const running = structuredClone(block.cases);
        notify();

        const outcome = await window.fragmentor.runCases(requireSnapshot().dir, block.path);
        ui.runningCases.delete(block.path);

        if (!outcome.ok) {
          ui.status = { text: `Could not run the tests: ${outcome.error}`, tone: "bad" };
        } else {
          ui.caseResults.set(block.path, outcome.value);
          ranAs.set(outcome.value, running);
          const passed = outcome.value.filter((entry) => entry.status === "passed").length;
          const checked = outcome.value.filter((entry) => entry.status !== "unchecked").length;
          ui.status = {
            text: `${passed} of ${checked} test${checked === 1 ? "" : "s"} passed.`,
            tone: passed === checked ? "good" : "bad",
          };
        }
        notify();
      })();
    });
    node.append(runAll);
  }

  if (ui.runningCases.has(block.path)) node.append(el("p", "bench-note", "Running tests…"));

  if (results && results.length > 0) {
    const passed = results.filter((entry) => entry.status === "passed").length;
    const checked = results.filter((entry) => entry.status !== "unchecked").length;
    node.append(
      el(
        "p",
        `case-summary ${passed === checked ? "passed" : "failed"}`,
        checked === 0 ? "No test has an expected output yet." : `${passed} of ${checked} passed.`,
      ),
    );

    for (const result of results) {
      if (result.status === "passed" || result.status === "unchecked") continue;
      const detail = result.differences.length > 0 ? result.differences : [result.error ?? "Failed."];
      const failed = problemList(result.name, detail, "bad");
      const testCase = ranAs.get(results)?.find((each) => each.name === result.name);
      if (testCase) {
        failed.append(
          flagOffer(block, {
            test: testCase.name,
            input: testCase.input,
            ...(testCase.stores === undefined ? {} : { stores: testCase.stores }),
            ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
            ...(result.output === undefined ? {} : { output: result.output }),
            problems: [...detail, ...result.inputProblems],
            logs: result.logs,
          }),
        );
      }
      node.append(failed);
    }
  }

  node.append(newCaseBox(block));
  return node;
}

/**
 * How a bench presents itself.
 *
 * The same bench serves two places: a block's own panel, and the entry of a
 * client or service that leads to it. The second is the point of the first —
 * pressing a button is what the system is for — and the values, the stores
 * and the result are the same, so the only difference is what it is called.
 */
interface BenchLook {
  /** What running it means here, when "run this block" is not what the person is doing. */
  note: string;
  runLabel: string;
}

export function benchSection(block: SnapshotBlock, look?: BenchLook): HTMLElement {
  // The window's own head already says what is being tried, so the section
  // says what it is instead of saying that again.
  const node = section("Input", "bench");

  const draft = draftFor(block);

  if (block.inputs.length === 0) {
    node.append(el("p", "bench-note", "This block takes no input."));
  } else {
    // Side by side while the window is wide enough for it: a form of six
    // short values down one thin column was most of why the bench scrolled.
    const fields = el("div", "bench-fields");
    for (const port of block.inputs) {
      fields.append(controlFor(port.typeIr, port.name, [port.name], draft));
    }
    node.append(fields);
  }

  const stores = storesForm(block);
  if (stores) node.append(stores);

  const run = el("button", "btn", look?.runLabel ?? "Run block");
  const unrunnable = whyNotRunnable(block);
  const note = el(
    "p",
    "bench-note",
    unrunnable ??
      look?.note ??
      "Runs the real block in a separate process, with substitutes for its capabilities, and plays the run back on the diagram.",
  );
  run.disabled = unrunnable !== null || ui.running.has(block.path);

  run.addEventListener("click", () => {
    if (node.querySelector('[data-invalid="true"]')) {
      ui.status = { text: "Some values are not valid JSON yet.", tone: "bad" };
      notify();
      return;
    }
    void runFromBench(block, { ...draft }, structuredClone(storesFor(block)));
  });

  node.append(run, note);
  return node;
}

/** What the last run gave back, in a section of its own so a wide window can put it beside the form. */
function resultSection(block: SnapshotBlock): HTMLElement | null {
  const result = resultPanel(block);
  if (!result) return null;
  const node = section("Result");
  node.append(result);
  return node;
}

/**
 * Everything the bench window holds for one block, in the order it is read.
 *
 * Each is a section of its own rather than one long strip, so a window pulled
 * wide lays them side by side and there is little left to scroll.
 *
 * The same bench serves two places: a block itself, and the entry of a client
 * or service that leads to it. The second is the point of the first — pressing
 * a button is what the system is for — and the values, the stores and the
 * result are the same, so the only difference is what it is called. That is
 * what makes a diagram runnable from the top: an agent presses `bookSeats` on
 * a box office and whatever answers it runs, watched, without anyone having to
 * know which block it lands in. The form is the answering block's, which is the
 * operation's too — `check` holds the two to the same shape.
 */
export function benchParts(block: SnapshotBlock, entry: string | null, route: string): HTMLElement[] {
  const look: BenchLook | undefined =
    entry === null
      ? undefined
      : {
          note: `Runs what answers this: ${route}. The blocks light up as they go, and any breakpoint still stops it.`,
          runLabel: `Run ${entry}`,
        };

  const parts = [benchSection(block, look)];
  const result = resultSection(block);
  if (result) parts.push(result);
  const watching = watchSection(block);
  if (watching) parts.push(watching);
  parts.push(casesSection(block));
  return parts;
}
