import type { SnapshotBlock, SnapshotCode } from "../../src/project/snapshot.js";
import type { ProjectDiagnostic } from "../../src/project/project.js";
import { blockColours, requireSnapshot, selectedBlock, ui, viewSettings } from "./state.js";
import { ROLES } from "../../src/model/roles.js";
import { accessSection, exposedSection, portSection } from "./detail.js";
import { accessArrows, blockColour, hasCode, hasDetails, revealBlock, toggleFold, treeInView } from "./canvas.js";
import { openBlockWindow } from "./popup.js";
import type { AccessArrow } from "./canvas.js";
import { benchSections, entryBenchSection } from "./bench.js";
import { watchSection } from "./watch.js";
import { el, group, section } from "./dom.js";
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
  const node = section("Source");
  const language = languageOf(block.language, block.files[ui.codeTab]);

  const tabs = el("div", "code-tabs");
  for (const [key, label] of [["impl", block.files.impl], ["contract", block.files.contract]] as const) {
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
        "This file has not been generated yet. Use Generate code.",
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
        block.sources.impl = editor.value;
        ui.edits.delete(block.path);
        ui.status = { text: `Saved ${block.path}/${block.files.impl}`, tone: "good" };
      }
      notify();
    })();
  });

  const revert = el("button", "btn quiet", "Revert");
  revert.addEventListener("click", () => {
    ui.edits.delete(block.path);
    notify();
  });

  const reveal = el("button", "btn quiet", "Show folder");
  reveal.addEventListener("click", () => {
    void window.fragmentor.revealBlock(requireSnapshot().dir, block.path);
  });

  const conflict = value !== onDisk && changedUnderneath();
  const dirty = el("p", conflict ? "bench-note bad" : "bench-note", describe());
  foot.append(save, revert, reveal, dirty);
  node.append(foot);
  return node;
}

/** The lines a visual block points at, numbered as in the file, with the one it names picked out. */
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

/** In a visual project a block's code is the person's own, shown and never changed. */
function linkedCodeSection(block: SnapshotBlock): HTMLElement {
  const node = section("Source");
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
  foot.append(reveal, el("p", "bench-note", "Visual mode: Fragmentor shows this code and never changes it."));
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

/**
 * The entries of this block that can actually be set going: those whose route
 * ends at code that has been written.
 *
 * It is the same walk the panel already shows, asked a different question, so
 * a button that leads somewhere and a button that can be pressed can never
 * disagree about where it leads.
 */
function runnableEntries(block: SnapshotBlock): { entry: string; answering: SnapshotBlock; route: string }[] {
  return block.exposes.flatMap((entry) => {
    const route = whatHappens(block, entry.name);
    const last = route.at(-1);
    if (route.length < 2 || !last || last.block.architecture) return [];
    if (!last.block.implemented || last.block.planned) return [];

    return [
      {
        entry: entry.name,
        answering: last.block,
        route: route
          .slice(1)
          .map((step) => (step.entry ? `${step.block.name} · ${step.entry}` : step.block.name))
          .join(" → "),
      },
    ];
  });
}

/**
 * Where an entry leads, and a way to get there.
 *
 * Shown on an architecture block, which has no bench of its own: the bench
 * belongs to whatever code answers it, and this is how you reach it.
 */
function whatHappensSection(block: SnapshotBlock): HTMLElement | null {
  const routes = block.exposes
    .map((entry) => ({ entry, route: whatHappens(block, entry.name) }))
    .filter(({ route }) => route.length > 1);
  if (routes.length === 0) return null;

  const node = section("When this happens");
  const list = el("div", "ports");

  for (const { entry, route } of routes) {
    const row = el("div", "port-row cap");
    row.append(el("div", "pname", entry.name));

    const rest = route.slice(1);
    row.append(el("div", "ptype", rest.map((step) => (step.entry ? `${step.block.name} · ${step.entry}` : step.block.name)).join("  →  ")));

    // Only worth offering where the chain ends at code that can be run.
    const last = rest.at(-1)!;
    if (!last.block.architecture) {
      const open = el("button", "btn quiet tiny", "Go there");
      open.title = `Show ${last.block.name}, where this is answered`;
      open.addEventListener("click", () => revealBlock(last.block.path));
      row.append(open);
    }
    list.append(row);
  }

  node.append(list);
  return node;
}

/** What an architecture block offers, in place of the contract it has none of. */
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

  const what = group("Access");
  const list = el("div", "ports");
  for (const access of arrow.entries) {
    const row = el("div", "port-row cap");
    row.append(el("div", "pname", access.verb));
    row.append(el("div", "ptype", access.entry === null ? "the whole thing" : access.entry));
    list.append(row);
  }
  const entries = section("What it touches");
  entries.append(list);
  what.append(entries);
  panel.append(what);

  if (target?.architecture) {
    const offered = group(target.name);
    offered.append(exposedSection(target));
    panel.append(offered);
  }
}

function blockPanel(panel: HTMLElement, block: SnapshotBlock): void {
  const visual = requireSnapshot().mode === "visual";

  const head = el("div", "insp-head");
  head.append(el("h2", undefined, block.name), el("div", "insp-id", block.path));

  const badges = el("div", "badges");
  // For a database or a queue, what it is matters more than whether it has
  // blocks inside it, so the role takes the first badge.
  badges.append(roleBadge(block));
  // What state a block is in only means something for one Fragmentor writes
  // or runs. A service is code — its blocks are right there inside it — so
  // saying "not code" of it was worse than saying nothing. In a visual
  // project it still points at a file, and that is worth saying.
  const state = block.planned
    ? "planned"
    : block.architecture
      ? visual
        ? block.implemented
          ? "linked to code"
          : "not linked"
        : null
      : visual
        ? block.implemented
          ? "linked to code"
          : "not linked"
        : block.implemented
          ? "implemented"
          : "specified";
  if (state) badges.append(el("span", `badge state${block.planned ? " planned" : ""}`, state));
  if (block.language) badges.append(el("span", "badge", block.language));
  head.append(badges);

  // Coloured block by block, this is where a block's colour is chosen; the
  // legend is where a kind's colour is chosen, and it is showing instead.
  const colour = blockColourControl(block);
  if (colour) head.append(colour);

  // The same windows the block's own buttons open, for whoever is reading
  // the panel rather than the tree.
  const windows = el("div", "insp-windows");
  if (hasDetails(block)) {
    const details = el("button", "btn quiet tiny", "What it holds");
    details.addEventListener("click", () => openBlockWindow("details", block.path));
    windows.append(details);
  }
  if (hasCode(block)) {
    const code = el("button", "btn quiet tiny", "Code");
    code.addEventListener("click", () => openBlockWindow("code", block.path));
    windows.append(code);
  }
  if (block.children.length > 0) {
    const fold = el("button", "btn quiet tiny", ui.folded.has(block.path) ? "Show its parts" : "Fold its parts");
    fold.addEventListener("click", () => toggleFold(block.path));
    windows.append(fold);
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

  // A block that is not code has no contract to be called through. What it
  // offers, and what reaches it, take the contract's place.
  if (block.architecture) {
    panel.append(
      el(
        "p",
        "planned-note",
        `${ROLES[block.role].description} Fragmentor draws it and checks that the diagram holds together, and generates, checks and runs nothing for it.`,
      ),
    );

    const offers = group("Offers");
    // A group of parts offers what the parts inside it do, so an empty list
    // of entries says nothing about it worth saying.
    if (block.role !== "component" || block.exposes.length > 0) offers.append(exposedSection(block));
    const happens = whatHappensSection(block);
    if (happens) offers.append(happens);
    const reached = accessSection(block);
    if (reached) offers.append(reached);
    // Its heading alone would promise something the block does not have.
    if (offers.childElementCount > 1) panel.append(offers);

    // Pressing the button, rather than only following where it leads. The
    // route ends at code, and the code is what runs.
    if (!visual) {
      const runnable = runnableEntries(block);
      if (runnable.length > 0) {
        const trying = group("Running it");
        for (const { entry, answering, route } of runnable) {
          trying.append(entryBenchSection(entry, answering, route));
        }
        panel.append(trying);
      }
    }

    // In a visual project even a service points at real code, and reading it
    // is the whole reason the diagram is there.
    if (visual) {
      const code = group("Code");
      code.append(linkedCodeSection(block));
      panel.append(code);
    }
    return;
  }

  const contract = group("Contract");
  contract.append(portSection("Inputs", block.inputs));
  contract.append(portSection("Outputs", block.outputs));
  contract.append(portSection("Capabilities", block.capabilities, true));
  const reaches = accessSection(block);
  if (reaches) contract.append(reaches);
  panel.append(contract);

  const code = group("Code");
  if (block.planned) {
    const none = section("None yet");
    none.append(
      el(
        "p",
        "bench-note",
        "There is no code for a planned block. When it is built, its \"planned\" flag comes off and its code appears here.",
      ),
    );
    code.append(none);
  } else {
    code.append(visual ? linkedCodeSection(block) : codeSection(block));
  }
  panel.append(code);
  // Nothing beneath this point applies to a block nobody has written: there
  // is nothing to run, and nothing a test could be run against.
  if (visual || block.planned) return;

  const testing = group("Testing");
  const [bench, cases] = benchSections(block);
  testing.append(bench);
  const watching = watchSection(block);
  if (watching) testing.append(watching);
  testing.append(cases);
  panel.append(testing);
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
    const node = section("What one reaches in another");
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
  panel.replaceChildren();

  if (!ui.snapshot || ui.waiting) {
    const note = !ui.dir
      ? "Open a project to inspect its blocks."
      : ui.waiting
        ? "There is nothing to inspect until the agent defines the system."
        : "There is nothing to inspect until the project can be read.";
    panel.append(el("p", "bench-note", note));
    return;
  }

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
  badges.append(el("span", "badge", `${snapshot.mode} mode`), el("span", "badge", `granularity ${snapshot.granularity.level}`));
  if (snapshot.language) badges.append(el("span", "badge", snapshot.language));
  head.append(badges);
  panel.append(head);
  if (snapshot.goal) panel.append(el("p", "responsibility", snapshot.goal));

  const problems = problemsSection(snapshot.diagnostics, true);
  if (problems) panel.append(problems);

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
      snapshot.mode === "visual"
        ? "Visual mode: the diagram describes this project's code, which Fragmentor never runs or changes."
        : "Systems in a project are separate programs. They are shown together but never connected, which is why each can be written in its own language.",
    ),
  );
}
