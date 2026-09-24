import type { SnapshotBlock, SnapshotCode } from "../../src/project/snapshot.js";
import type { ProjectDiagnostic } from "../../src/project/project.js";
import { blockColours, requireSnapshot, selectedBlock, ui, viewSettings } from "./state.js";
import { ROLES } from "../../src/model/roles.js";
import { interfaceSection, reachesSection } from "./detail.js";
import type { EntryRoute } from "./detail.js";
import { accessArrows, blockColour, hasCode, hasDetails, revealBlock, treeInView } from "./canvas.js";
import { openBlockWindow, openCodeAt } from "./popup.js";
import { STEP_LINK, currentStep, describeStep } from "./execution.js";
import { travelOf } from "../../src/model/trace.js";
import type { AccessArrow } from "./canvas.js";
import { openBenchWindow } from "./benchpanel.js";
import { versionBadge, versionsSection } from "./versions.js";
import { notesSection, projectNotesSection } from "./notes.js";
import { el, keepingFocus, section } from "./dom.js";
import { codeBlock, codeFragment, codeLines, languageOf } from "./highlight.js";

let notify: () => void = () => {};
export function onInspectorChange(callback: () => void): void {
  notify = callback;
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the checks found. For the whole project every problem is listed, each
 * leading to its block; for one block, only that block's own.
 */
function problemsSection(diagnostics: ProjectDiagnostic[], linked: boolean): HTMLElement | null {
  if (diagnostics.length === 0) return null;

  const node = section("Problems");
  const list = el("div", "problems");
  const ordered = [
    ...diagnostics.filter((d) => d.severity === "error"),
    ...diagnostics.filter((d) => d.severity === "warning"),
  ];

  for (const diagnostic of ordered) {
    // A problem with a file beside the blocks, such as an execution, has no block to go to.
    const goes = linked && Boolean(ui.snapshot?.blocks[diagnostic.blockPath]);
    const row = el(goes ? "button" : "div", `problem ${diagnostic.severity}`);
    row.append(el("span", "problem-level", diagnostic.severity));
    if (linked) row.append(el("span", "problem-where", diagnostic.blockPath));
    if (goes) {
      row.title = "Show this block";
      row.addEventListener("click", () => revealBlock(diagnostic.blockPath));
    }
    row.append(el("span", "problem-text", diagnostic.message));
    list.append(row);
  }

  node.append(list);
  return node;
}

function editableCode(value: string, language: ReturnType<typeof languageOf>): {
  wrap: HTMLElement;
  editor: HTMLTextAreaElement;
} {
  const wrap = el("div", "code-edit");
  const shown = el("pre", "code-edit-view");
  shown.setAttribute("aria-hidden", "true");

  const editor = el("textarea", "code-edit-input");
  editor.spellcheck = false;
  editor.value = value;

  const recolour = () => {
    // The extra newline keeps the coloured copy as tall as the text being
    // typed, so the last line is never clipped as the box scrolls.
    shown.replaceChildren(codeFragment(`${editor.value}\n`, language));
  };

  recolour();
  editor.addEventListener("input", recolour);
  editor.addEventListener("scroll", () => {
    shown.scrollTop = editor.scrollTop;
    shown.scrollLeft = editor.scrollLeft;
  });

  wrap.append(shown, editor);
  return { wrap, editor };
}

function codeSection(block: SnapshotBlock): HTMLElement {
  const node = section("Code");
  const language = languageOf(block.language, block.files[ui.codeTab]);

  const tabs = el("div", "code-tabs");
  for (const [key, label] of [["code", block.files.code], ["contract", block.files.contract]] as const) {
    const chip = el("button", "chip", label);
    chip.setAttribute("aria-pressed", String(ui.codeTab === key));
    chip.addEventListener("click", () => {
      ui.codeTab = key;
      notify();
    });
    tabs.append(chip);
  }
  node.append(tabs);

  // A textarea hands back its text with \n line endings whatever the file
  // uses, so the file is compared in the same form or it would never match.
  const onDisk = block.sources[ui.codeTab]?.replace(/\r\n/g, "\n") ?? null;
  // A contract is derived from the diagram, so it is nobody's to edit.
  const generated = ui.codeTab === "contract";
  const pending = ui.edits.get(block.path);
  const value = generated ? onDisk : (pending?.text ?? onDisk);

  if (value === null || value === undefined) {
    node.append(
      el(
        "p",
        "bench-note",
        ui.codeTab === "contract"
          ? "This block's contract has not been written yet. Its code imports it, and `fragmentor check` writes it."
          : "The code this block points at is not there.",
      ),
    );
    return node;
  }

  if (generated) {
    node.append(codeBlock(value, language, "code code-view"));
    node.append(
      el(
        "p",
        "bench-note",
        "Generated from block.json, so it is read-only. Change the diagram and it is rewritten.",
      ),
    );
    return node;
  }

  const { wrap, editor } = editableCode(value, language);
  node.append(wrap);

  const foot = el("div", "code-foot");

  // The file on disk is not the one editing started from: someone else —
  // usually the agent — rewrote it in the meantime.
  const changedUnderneath = () => {
    const edit = ui.edits.get(block.path);
    return Boolean(edit && edit.base !== onDisk);
  };

  const describe = () => {
    if (editor.value === onDisk) return "Saved.";
    if (changedUnderneath()) {
      return "This file changed on disk while you were editing it. Saving replaces that change; Revert shows it.";
    }
    return "Unsaved changes.";
  };

  editor.addEventListener("input", () => {
    if (editor.value === onDisk) ui.edits.delete(block.path);
    else ui.edits.set(block.path, { base: ui.edits.get(block.path)?.base ?? onDisk, text: editor.value });
    save.disabled = editor.value === onDisk;
    dirty.textContent = describe();
    dirty.classList.toggle("bad", editor.value !== onDisk && changedUnderneath());
  });

  const save = el("button", "btn", "Save to disk");
  save.disabled = value === onDisk;
  save.addEventListener("click", () => {
    void (async () => {
      const snapshot = requireSnapshot();
      const result = await window.fragmentor.writeImpl({
        dir: snapshot.dir,
        blockPath: block.path,
        contents: editor.value,
      });

      if (!result.ok) {
        ui.status = { text: `Could not save ${block.path}: ${result.error}`, tone: "bad" };
      } else {
        block.sources.code = editor.value;
        ui.edits.delete(block.path);
        ui.status = { text: `Saved ${block.files.code}`, tone: "good" };
      }
      notify();
    })();
  });

  const revert = el("button", "btn quiet", "Revert");
  revert.addEventListener("click", () => {
    ui.edits.delete(block.path);
    notify();
  });

  // The file being edited, which is wherever the codebase keeps it, rather
  // than the block's own folder, which holds what the block is.
  const reveal = el("button", "btn quiet", "Show in folder");
  reveal.addEventListener("click", () => {
    void window.fragmentor.revealCode(requireSnapshot().dir, block.files.code);
  });

  const conflict = value !== onDisk && changedUnderneath();
  const dirty = el("p", conflict ? "bench-note bad" : "bench-note", describe());
  foot.append(save, revert, reveal, dirty);
  node.append(foot);
  return node;
}

/** The lines a block points at, numbered as in the file, with the one it names picked out. */
function excerptOf(code: SnapshotCode, language: ReturnType<typeof languageOf>): HTMLElement {
  const pre = el("pre", "code code-excerpt");
  codeLines(code.excerpt ?? "", language).forEach((coloured, i) => {
    const number = code.excerptStart + i;
    const line = el("span", number === code.line ? "excerpt-line target" : "excerpt-line");
    line.append(el("span", "excerpt-number", String(number)));
    while (coloured.firstChild) line.append(coloured.firstChild);
    pre.append(line);
  });
  return pre;
}

/** Code Fragmentor only draws: shown, never edited from here. */
function linkedCodeSection(block: SnapshotBlock): HTMLElement {
  const node = section("Code");
  const code = block.code;

  if (!code) {
    node.append(
      el(
        "p",
        "bench-note",
        requireSnapshot().diagnostics.some((d) => d.blockPath === block.path && /points at code/.test(d.message))
          ? "The code this block points at is not there; the problem is listed above."
          : "This block does not say where its code is. The agent adds a \"code\" pointer to its block.json.",
      ),
    );
    return node;
  }

  node.append(el("div", "code-where", code.line ? `${code.file} : line ${code.line}` : code.file));
  if (code.excerpt !== null) node.append(excerptOf(code, languageOf(block.language, code.file)));
  else node.append(el("p", "bench-note", "This points at a folder, or at a file too large to show here."));

  const foot = el("div", "code-foot");
  const reveal = el("button", "btn quiet", "Show in folder");
  reveal.addEventListener("click", () => {
    void window.fragmentor.revealCode(requireSnapshot().dir, code.file);
  });
  foot.append(
    reveal,
    el("p", "bench-note", block.drawnBecause ?? "Fragmentor shows this code and never changes it."),
  );
  node.append(foot);
  return node;
}

/**
 * What this one block is drawn in, when the diagram is coloured block by
 * block. Its own colour is a viewing preference like the legend's, so it is
 * remembered for this diagram in this profile rather than written into the
 * project, where it would be someone else's diagram too.
 */
function blockColourControl(block: SnapshotBlock): HTMLElement | null {
  if (viewSettings.colourBy !== "block" || !treeInView()?.nodes.has(block.path)) return null;

  const row = el("div", "block-colour");
  const swatch = el("input", "legend-swatch");
  swatch.type = "color";
  swatch.value = blockColour(block.path);
  swatch.title = `What "${block.name}" is drawn in`;
  swatch.addEventListener("input", () => {
    blockColours.set("", block.path, swatch.value);
    notify();
  });

  const reset = el("button", "btn quiet tiny", "Default");
  reset.addEventListener("click", () => {
    blockColours.set("", block.path, null);
    notify();
  });

  row.append(el("span", "block-colour-label", "Colour"), swatch, reset);
  return row;
}

/** Named and coloured the way the block is drawn on the canvas. */
function roleBadge(block: SnapshotBlock): HTMLElement {
  const badge = el("span", "badge role", block.roleLabel.toLowerCase());
  badge.dataset.role = block.role;
  return badge;
}

/** One step of what happens when an entry is triggered. */
interface Step {
  block: SnapshotBlock;
  entry: string | null;
}

/** Long enough for any real chain, short enough that a loop cannot hang the panel. */
const MOST_STEPS = 12;

/**
 * What actually runs when one entry happens.
 *
 * A button on a client calls an operation on a service; that operation says
 * which block answers it; and that block is code, with a contract and a test
 * bench. Following those two links end to end turns "this button" into "this
 * function", which is the whole reason for saying which entry does the
 * reaching rather than only that two blocks are connected.
 *
 * Returns every step of the way, so the panel can show the route and not only
 * where it ends up.
 */
function whatHappens(block: SnapshotBlock, entry: string): Step[] {
  const snapshot = requireSnapshot();
  const route: Step[] = [];
  let at: Step | null = { block, entry };

  while (at && route.length < MOST_STEPS) {
    route.push(at);
    const here: Step = at;
    at = null;

    // A function block is where it ends: that is the code that runs.
    if (!here.block.architecture || here.entry === null) break;

    // An operation that names the block answering it leads straight into code.
    const exposed = here.block.exposes.find((each) => each.name === here.entry);
    if (exposed?.block) {
      const answering = snapshot.blocks[`${here.block.path}/${exposed.block}`];
      if (answering) at = { block: answering, entry: null };
      if (at) continue;
    }

    // Otherwise this entry may call another block's entry, and on it goes.
    const call = here.block.access.find((each) => each.from === here.entry && each.resourcePath !== null);
    const next = call?.resourcePath ? snapshot.blocks[call.resourcePath] : undefined;
    if (next) at = { block: next, entry: call!.entry };
  }

  return route;
}

/** One of this block's entries, and what the walk above found at the end of it. */
interface Leads {
  entry: string;
  /** The way there in words, for the entry's own row. */
  route: string;
  /** Where it ends up. */
  last: SnapshotBlock;
}

/**
 * Where each of this block's entries leads.
 *
 * One walk answers two questions — where does this button go, and can it be
 * pressed — so the row saying where it leads and the button that runs it can
 * never disagree about the route.
 */
function entryLeads(block: SnapshotBlock): Leads[] {
  if (!block.architecture) return [];

  return block.exposes.flatMap((entry) => {
    const rest = whatHappens(block, entry.name).slice(1);
    const last = rest.at(-1);
    if (!last) return [];

    return [
      {
        entry: entry.name,
        route: rest.map((step) => (step.entry ? `${step.block.name} · ${step.entry}` : step.block.name)).join("  →  "),
        last: last.block,
      },
    ];
  });
}

/** The same routes, as the entries' own rows want them. */
function routesOf(leads: Leads[]): EntryRoute[] {
  return leads.map(({ entry, route, last }) => ({
    entry,
    route,
    endsAt: last.architecture ? null : last.path,
  }));
}

/**
 * One step of an execution: what it is, which blocks it joins, what it
 * carried, and the code that makes it happen.
 *
 * The step is the thing being read while someone is stepping through, so it
 * has a page of its own rather than a line in the bar above the tree.
 */
function stepPanel(panel: HTMLElement): boolean {
  const step = currentStep();
  if (!step) return false;
  const snapshot = requireSnapshot();
  const { event, execution } = step;
  const trigger = execution.trigger.kind;

  const head = el("div", "insp-head");
  head.append(
    el("h2", undefined, `Step ${step.at + 1} of ${step.trace.events.length}`),
    el("div", "insp-id", `${execution.name} · ${step.trace.source}`),
  );
  panel.append(head);

  // What the agent said about this step, and failing that, what it does.
  const said = event.type === "return" ? undefined : event.description;
  panel.append(el("p", "responsibility", said ?? describeStep(event, trigger, 400)));
  if (said) panel.append(el("p", "bench-note", describeStep(event, trigger, 400)));

  // "Where", not "between": an effect happens at one block rather than
  // between two, and this is the section that says so for both.
  const where = section("Where");
  const list = el("div", "ports");
  let missing = false;
  const place = (label: string, address: { path: string; entry: string | null } | null) => {
    const row = el("div", "port-row");
    row.append(el("div", "pname", label));
    if (address === null) {
      row.append(el("div", "ptype", "outside the system"));
    } else {
      if (!snapshot.blocks[address.path]) missing = true;
      const block = snapshot.blocks[address.path];
      const where = el("div", "pwhere");
      where.append(
        el("span", "ptype", address.entry === null ? (block?.name ?? address.path) : `${block?.name ?? address.path} · ${address.entry}`),
      );
      const show = el("button", "btn quiet tiny", "Show");
      show.addEventListener("click", () => revealBlock(address.path));
      where.append(show);
      row.append(where);
    }
    list.append(row);
  };

  if (event.type === "effect") {
    place("at", event.at);
  } else {
    // The same way round as the arrow on the drawing and the words under it:
    // an answer leaves whoever was called and arrives at whoever asked.
    const runs = travelOf(event) ?? event;
    place("from", runs.from);
    place("to", runs.to);
    const kind = el("div", "port-row");
    kind.append(el("div", "pname", "kind"), el("div", "ptype", event.type === "return" ? "gives back" : event.kind));
    list.append(kind);
  }
  where.append(list);
  panel.append(where);

  // Nothing is drawn for a step whose block has been taken out of the
  // project, and the tree saying nothing would be the only sign of it.
  if (missing) {
    panel.append(
      el("p", "bench-note bad", "This step names a block that is not in the project, so there is nothing to draw it between. The problems list says which."),
    );
  }

  const carried =
    event.type === "effect" ? event.detail : event.type === "return" ? event.response : event.payload;
  if (carried !== undefined) {
    const what = section(event.type === "return" ? "What came back" : "What it carried");
    what.append(codeBlock(JSON.stringify(carried, null, 2) ?? "", "json"));
    panel.append(what);
  }

  // An answer comes back out of the call it answers, so that call's function
  // is the one it returns from.
  const answers = event.type === "return" ? step.trace.events.find((each) => each.id === event.of) : undefined;
  const pointer = event.type === "return" ? (answers?.type === "interaction" ? answers.code : undefined) : event.code;
  const code = section("Code");
  if (pointer === undefined) {
    code.append(el("p", "bench-note", "This step does not say which function makes it."));
  } else {
    code.append(el("div", "code-where", pointer));
    code.append(
      el("p", "bench-note", event.type === "return" ? "The function this answer comes back from." : "The function that makes this step."),
    );
    const open = el("button", "btn", "Open the code");
    open.addEventListener("click", () => void openCodeAt(pointer, `Step ${step.at + 1}: ${execution.name}`));
    code.append(open);
  }
  panel.append(code);

  if (step.trace.source === "declared") {
    panel.append(
      el("p", "bench-note", "Written down by the agent from reading the code. Fragmentor has not seen it run."),
    );
  }
  return true;
}

/** One dependency arrow picked out on the tree. */
function accessPanel(panel: HTMLElement, arrow: AccessArrow): void {
  const snapshot = requireSnapshot();
  const source = snapshot.blocks[arrow.source];
  const target = snapshot.blocks[arrow.target];

  const head = el("div", "insp-head");
  head.append(el("h2", undefined, `${source?.name ?? arrow.source} and ${target?.name ?? arrow.target}`));
  head.append(el("div", "insp-id", "dependency"));
  panel.append(head);

  panel.append(
    el(
      "p",
      "responsibility",
      "Something this block is able to reach. It says nothing about what happens, or when: that is what an execution shows.",
    ),
  );

  // The same two headings a block's own panel uses: what this reaches, and the
  // interface it reaches it through.
  const reaches = section("Reaches");
  const list = el("div", "ports");
  for (const access of arrow.entries) {
    const row = el("div", "port-row cap");
    row.append(el("div", "pname", access.verb));
    row.append(el("div", "ptype", access.entry === null ? "the whole thing" : access.entry));
    list.append(row);
  }
  reaches.append(list);
  panel.append(reaches);

  if (target?.architecture) {
    const shape = interfaceSection(target);
    shape.append(el("p", "bench-note", `What ${target.name} offers, whoever reaches it.`));
    panel.append(shape);
  }
}

function blockPanel(panel: HTMLElement, block: SnapshotBlock): void {
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, block.name), el("div", "insp-id", block.path));

  const badges = el("div", "badges");
  // For a database or a queue, what it is matters more than whether it has
  // blocks inside it, so the role takes the first badge.
  badges.append(roleBadge(block));
  // What state a block is in: whether the code it points at is there, and
  // whether Fragmentor holds that code to a contract or only draws it. A block
  // that names no code at all — a service, a group of parts — says nothing,
  // because "not code" of a service was worse than saying nothing.
  const state = block.planned
    ? "planned"
    : block.code === null
      ? null
      : !block.implemented
        ? "code not found"
        : block.runnable
          ? "checked and runnable"
          : "drawn";
  if (state) badges.append(el("span", `badge state${block.planned ? " planned" : ""}`, state));
  if (block.language) badges.append(el("span", "badge", block.language));
  // Which version the block is on, from the list its Versions section reads,
  // so it is seen without scrolling to the bottom of the panel.
  badges.append(versionBadge(block));
  head.append(badges);

  // Coloured block by block, this is where a block's colour is chosen; the
  // legend is where a kind's colour is chosen, and it is showing instead.
  const colour = blockColourControl(block);
  if (colour) head.append(colour);

  // The same windows the block's own buttons open, for whoever is reading
  // the panel rather than the tree. They are named after the sections they
  // hold, so the button and the heading it leads to are the same word.
  const windows = el("div", "insp-windows");
  if (hasDetails(block)) {
    const details = el("button", "btn quiet tiny", "Interface");
    details.title = `What ${block.name} can be used through, and what it reaches`;
    details.addEventListener("click", () => openBlockWindow("details", block.path));
    windows.append(details);
  }
  if (hasCode(block)) {
    const code = el("button", "btn quiet tiny", "Code");
    code.title = `The code behind ${block.name}`;
    code.addEventListener("click", () => openBlockWindow("code", block.path));
    windows.append(code);
  }
  if (windows.childElementCount > 0) head.append(windows);
  panel.append(head);

  panel.append(el("p", "responsibility", block.responsibility));

  if (block.planned) {
    panel.append(
      el(
        "p",
        "planned-note",
        "Planned: part of the architecture rather than of the program. Its ports say what is meant to flow rather than what does, its wiring can be as loose as the plan is, and Fragmentor generates, checks and runs nothing for it.",
      ),
    );
  }

  const problems = problemsSection(requireSnapshot().diagnostics.filter((d) => d.blockPath === block.path), false);
  if (problems) panel.append(problems);

  // What the person and the agent have asked each other about the block comes
  // before what the block is, because it is what is waiting to be done.
  panel.append(notesSection(block));

  // A block that is not code says what kind of thing it is. It is a quiet
  // line rather than the dashed box a planned block gets: a database is not a
  // warning about anything, and what Fragmentor does not do with it is
  // already said by the sections it has none of.
  if (block.architecture) panel.append(el("p", "role-note", ROLES[block.role].description));

  // The same sections, in the same order, whatever kind of block this is: its
  // notes, then what it can be used through, what it reaches, where its code is, how to set it
  // going, and last, its earlier versions. A block simply may not have one of
  // the middle ones; every block has versions, or a sentence saying why not.
  const leads = entryLeads(block);
  panel.append(interfaceSection(block, routesOf(leads)));

  const reaches = reachesSection(block);
  if (reaches) panel.append(reaches);

  if (block.architecture) {
    // A block that is not called can still point at the module standing for
    // it, and reading that is often why the diagram is there at all. It never
    // has code of its own, so there is nothing to say when it points nowhere.
    if (block.code !== null) panel.append(linkedCodeSection(block));
  } else if (block.planned) {
    const none = section("Code");
    none.append(
      el(
        "p",
        "bench-note",
        "There is none: this block is planned. When it is built, its \"planned\" flag comes off and its code appears here.",
      ),
    );
    panel.append(none);
  } else {
    // Code held to a contract is Fragmentor's to offer for editing, beside the
    // contract holding it. Code it only draws is shown as it is.
    panel.append(block.runnable ? codeSection(block) : linkedCodeSection(block));
  }

  panel.append(...runSections(block, leads));
  panel.append(versionsSection(block));
}

/**
 * The ways into the bench: this block itself, or whichever of its entries end
 * at code that can be run.
 *
 * Trying something out is a window of its own — a form, the rows a store starts
 * with, what came back and the saved tests are more than a panel beside the
 * diagram can hold — so the section keeps one button per way in and nothing
 * else. Pressing an entry is the point of the diagram being runnable at all:
 * the bench that opens is the answering block's, and the person pressing it
 * never has to know which block that is.
 */
function runSections(block: SnapshotBlock, leads: Leads[]): HTMLElement[] {
  if (block.planned) return [];

  if (!block.architecture) {
    if (!block.runnable) return [];
    const node = section("Run");
    node.append(
      benchButton(
        block,
        `Try ${block.name}`,
        `Type values in, run ${block.name} on its own, and see what it left behind. Its saved tests and breakpoints are there too.`,
        null,
        null,
      ),
    );
    return [node];
  }

  const runnable = leads.filter(({ last }) => !last.architecture && last.runnable);
  if (runnable.length === 0) return [];
  const node = section("Run");
  for (const { entry, route, last } of runnable) {
    node.append(benchButton(last, `Try ${entry}`, `Runs what answers it: ${route}`, entry, route));
  }
  return [node];
}

/** The one thing the inspector keeps of the bench: the way into it. */
function benchButton(
  block: SnapshotBlock,
  label: string,
  note: string,
  entry: string | null,
  route: string | null,
): HTMLElement {
  const node = el("div", "run-way");
  const open = el("button", "btn", label);
  open.type = "button";
  open.addEventListener("click", () => {
    openBenchWindow(block.path, entry);
    if (ui.bench && route !== null) ui.bench.route = route;
    notify();
  });
  node.append(open, el("p", "bench-note", note));
  return node;
}

function multiPanel(panel: HTMLElement): void {
  const snapshot = requireSnapshot();
  const keys = [...ui.selection];
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, `${keys.length} blocks selected`), el("div", "insp-id", keys.join(", ")));
  panel.append(head);

  const tree = treeInView();
  const between = tree
    ? [...accessArrows(tree).values()].filter((arrow) => ui.selection.has(arrow.source) && ui.selection.has(arrow.target))
    : [];
  if (between.length > 0) {
    const node = section("Reaches");
    const list = el("div", "ports");
    for (const arrow of between) {
      const row = el("div", "port-row");
      row.append(el("div", "pname", `${snapshot.blocks[arrow.source]?.name} → ${snapshot.blocks[arrow.target]?.name}`));
      row.append(el("div", "ptype", arrow.entries.map((entry) => entry.text).join(", ")));
      list.append(row);
    }
    node.append(list);
    panel.append(node);
  }

  panel.append(el("p", "bench-note", "Ctrl-click a block to add or remove it from the selection."));
}

export function renderInspector(): void {
  const panel = document.getElementById("inspector");
  if (!panel) return;

  // The panel is drawn afresh whenever the agent changes a file, often while
  // the person is writing a note to it.
  keepingFocus(panel, () => {
    panel.replaceChildren();
    build(panel);
  });
}

function build(panel: HTMLElement): void {

  if (!ui.snapshot || ui.waiting) {
    const note = !ui.dir
      ? "Open a project to inspect its blocks."
      : ui.waiting
        ? "There is nothing to inspect until the agent defines the system."
        : "There is nothing to inspect until the project can be read.";
    panel.append(el("p", "bench-note", note));
    return;
  }

  // The step being stepped through is what someone reading it wants, and it
  // gives way as soon as they pick something else out.
  if (ui.selectedLink === STEP_LINK && stepPanel(panel)) return;

  const tree = treeInView();

  if (tree && ui.selectedLink) {
    const arrow = accessArrows(tree).get(ui.selectedLink);
    if (arrow) {
      accessPanel(panel, arrow);
      return;
    }
  }

  if (ui.selection.size > 1) {
    multiPanel(panel);
    return;
  }

  const snapshot = requireSnapshot();
  const only = selectedBlock();
  if (only) {
    blockPanel(panel, only);
    return;
  }

  // Nothing is selected and the canvas is showing the project itself.
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, snapshot.name), el("div", "insp-id", snapshot.dir));
  const badges = el("div", "badges");
  badges.append(el("span", "badge", `granularity ${snapshot.granularity.level}`));
  if (snapshot.language) badges.append(el("span", "badge", snapshot.language));
  head.append(badges);
  panel.append(head);
  if (snapshot.goal) panel.append(el("p", "responsibility", snapshot.goal));

  const problems = problemsSection(snapshot.diagnostics, true);
  if (problems) panel.append(problems);

  panel.append(projectNotesSection());

  const systems = section("Systems");
  const list = el("div", "ports");
  for (const system of snapshot.systems) {
    const root = snapshot.blocks[system.rootBlock];
    const row = el("div", "port-row");
    row.append(el("div", "pname", root?.name ?? system.rootBlock));
    row.append(el("div", "ptype", system.known ? system.displayName : `${system.language} — no language pack`));
    if (root) row.append(el("div", "pdesc", root.responsibility));
    list.append(row);
  }
  systems.append(list);
  panel.append(systems);

  panel.append(
    el(
      "p",
      "bench-note",
      "Systems in a project are separate programs. They are shown together but never connected, which is why each can be written in its own language.",
    ),
  );
}
