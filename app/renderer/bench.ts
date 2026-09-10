import type { PortType } from "../../src/model/types.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { TestCase } from "../../src/run/cases.js";
import type { CaseResult } from "../../src/run/run.js";
import { requireSnapshot, ui } from "./state.js";

/**
 * The test bench: enter values, run the block, see what came back.
 *
 * The form is built from the block's port types, so it always matches the
 * contract rather than being written separately and drifting from it. What is
 * typed is kept per block, because running redraws the panel and losing the
 * values every time would make the bench useless.
 */

let notify: () => void = () => {};
export function onBenchChange(callback: () => void): void {
  notify = callback;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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

function problemList(title: string, problems: string[], tone: string): HTMLElement {
  const wrap = el("div", "run-problems");
  wrap.append(el("h4", tone, title));
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
    panel.append(problemList("The block failed", [outcome.error ?? "No reason given."], "bad"));
  } else {
    const output = el("pre", "code", JSON.stringify(outcome.output, null, 2));
    panel.append(el("h4", "good", `Output — ${outcome.durationMs} ms`), output);
  }

  if (outcome.outputProblems.length > 0) {
    panel.append(problemList("The result does not match what this block promises", outcome.outputProblems, "bad"));
  }

  if (outcome.logs.length > 0) {
    panel.append(el("h4", undefined, "Logged"), el("pre", "code", outcome.logs.join("\n")));
  }

  return panel;
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

function statusWord(status: CaseResult["status"]): string {
  return status === "unchecked" ? "no expectation" : status;
}

function caseRow(block: SnapshotBlock, testCase: TestCase, result: CaseResult | undefined): HTMLElement {
  const row = el("div", "case-row");
  row.append(el("div", "case-name", testCase.name));

  if (result) row.append(el("div", `case-status ${result.status}`, statusWord(result.status)));
  else if (testCase.expected === undefined) row.append(el("div", "case-status unchecked", "no expectation"));

  const actions = el("div", "case-actions");

  const load = el("button", undefined, "Load");
  load.title = "Put this test's input into the form above.";
  load.addEventListener("click", () => {
    ui.benchInputs.set(block.path, structuredClone(testCase.input) as Draft);
    ui.status = { text: `Loaded "${testCase.name}".`, tone: "info" };
    notify();
  });

  const remove = el("button", undefined, "Delete");
  remove.addEventListener("click", () => {
    void writeCases(block, block.cases.filter((entry) => entry.name !== testCase.name));
  });

  actions.append(load, remove);
  row.append(actions);
  return row;
}

function casesSection(block: SnapshotBlock): HTMLElement {
  const node = el("section", "section");
  node.append(el("h3", undefined, "Saved tests"));

  const results = ui.caseResults.get(block.path);
  const byName = new Map((results ?? []).map((result) => [result.name, result]));

  if (block.cases.length === 0) {
    node.append(el("p", "bench-note", "No tests saved yet. Fill in the values above and save them as a test."));
  } else {
    const list = el("div", "cases");
    for (const testCase of block.cases) list.append(caseRow(block, testCase, byName.get(testCase.name)));
    node.append(list);
  }

  // Saving the current input, optionally with the last output as the expectation.
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

  const expectLabel = el("label", undefined, canExpect ? "expect the last output" : "run the block first to expect an output");
  expectLabel.htmlFor = expectBox.id;
  expectLabel.style.fontSize = "11.5px";
  expectLabel.style.color = "var(--ink-dim)";

  const save = el("button", "btn quiet", "Save as test");
  save.addEventListener("click", () => {
    const name = (ui.caseNames.get(block.path) ?? "").trim();
    if (!name) {
      ui.status = { text: "Give the test a name first.", tone: "bad" };
      notify();
      return;
    }

    const draft = structuredClone(draftFor(block)) as unknown;
    const testCase: TestCase = expectBox.checked && lastRun?.ok
      ? { name, input: draft, expected: structuredClone(lastRun.output) }
      : { name, input: draft };

    const kept = block.cases.filter((entry) => entry.name !== name);
    ui.caseNames.set(block.path, "");
    void writeCases(block, [...kept, testCase]);
  });

  const saveRow = el("div", "case-save");
  saveRow.append(nameField, save);
  node.append(saveRow);

  const expectRow = el("div", "case-save");
  expectRow.append(expectBox, expectLabel);
  node.append(expectRow);

  // Running them all.
  const runAll = el("button", "btn", "Run all tests");
  runAll.disabled = block.cases.length === 0 || ui.runningCases.has(block.path) || !block.implemented;
  runAll.addEventListener("click", () => {
    void (async () => {
      ui.runningCases.add(block.path);
      ui.caseResults.delete(block.path);
      notify();

      const outcome = await window.fragmentor.runCases(requireSnapshot().dir, block.path);
      ui.runningCases.delete(block.path);

      if (!outcome.ok) {
        ui.status = { text: `Could not run the tests: ${outcome.error}`, tone: "bad" };
      } else {
        ui.caseResults.set(block.path, outcome.value);
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
      node.append(problemList(result.name, detail, "bad"));
    }
  }

  return node;
}

export function benchSection(block: SnapshotBlock): HTMLElement {
  const node = el("section", "section bench");
  node.append(el("h3", undefined, "Test bench"));

  const draft = draftFor(block);

  if (block.inputs.length === 0) {
    node.append(el("p", "bench-note", "This block takes no input."));
  } else {
    for (const port of block.inputs) {
      node.append(controlFor(port.typeIr, port.name, [port.name], draft));
    }
  }

  const run = el("button", "btn", "Run block");
  const note = el("p", "bench-note");

  if (!block.implemented) {
    run.disabled = true;
    note.textContent = "This block has no implementation yet, so there is nothing to run.";
  } else if (block.language !== "typescript") {
    run.disabled = true;
    note.textContent = `Fragmentor cannot run ${block.language} blocks yet.`;
  } else {
    note.textContent = "Runs the real block in a separate process, with substitutes for its capabilities.";
  }

  run.disabled = run.disabled || ui.running.has(block.path);

  run.addEventListener("click", () => {
    if (node.querySelector('[data-invalid="true"]')) {
      ui.status = { text: "Some values are not valid JSON yet.", tone: "bad" };
      notify();
      return;
    }

    void (async () => {
      ui.running.add(block.path);
      ui.runs.delete(block.path);
      notify();

      const result = await window.fragmentor.runBlock({
        dir: requireSnapshot().dir,
        blockPath: block.path,
        input: { ...draft },
      });

      ui.running.delete(block.path);

      if (!result.ok) {
        ui.status = { text: `Could not run ${block.path}: ${result.error}`, tone: "bad" };
      } else {
        ui.runs.set(block.path, result.value);
        ui.status = result.value.ok
          ? { text: `${block.name} ran in ${result.value.durationMs} ms.`, tone: "good" }
          : { text: `${block.name} did not finish.`, tone: "bad" };
      }
      notify();
    })();
  });

  node.append(run, note);

  const result = resultPanel(block);
  if (result) node.append(result);

  return node;
}

/** The bench and its saved tests, which the inspector shows together. */
export function benchSections(block: SnapshotBlock): HTMLElement[] {
  return [benchSection(block), casesSection(block)];
}
