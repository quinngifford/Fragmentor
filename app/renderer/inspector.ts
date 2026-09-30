import type { SnapshotBlock, SnapshotCode } from "../../src/project/snapshot.js";
import type { ProjectDiagnostic } from "../../src/project/project.js";
import { blockColours, requireSnapshot, selectedBlock, ui, viewSettings } from "./state.js";
import { accessPanel, blockAbout, blockHead, interfaceSection, multiPanel, reachesSection } from "./detail.js";
import type { EntryRoute } from "./detail.js";
import { accessArrows, blockColour, hasCode, hasDetails, revealBlock, treeInView } from "./canvas.js";
import { openBlockWindow, openCodeAt } from "./popup.js";
import { STEP_LINK, stepPage } from "./execution.js";
import { openBenchWindow } from "./benchpanel.js";
import { versionBadge, versionsSection } from "./versions.js";
import { holdOffer, noteOn, notesSection, problemFlag, projectNotesSection } from "./notes.js";
import { ruleOffers, rulesSection } from "./rules.js";
import { blockChangesSection, projectChangesSection } from "./changes.js";
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
    const flag = problemFlag(diagnostic.blockPath, diagnostic.message);
    if (flag) {
      const line = el("div", "problem-line");
      line.append(row, flag);
      list.append(line);
    } else {
      list.append(row);
    }
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
  const hold = holdOffer(block);
  if (hold) node.append(hold);
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

/** One of this block's entries, and where what happens when it is used ends up. */
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
 * A button on a client calls an operation on a service; that operation says
 * which block answers it; and that block is code, with a contract and a test
 * bench. The kernel follows those links end to end, as it does to find the
 * code a recording runs, and one route answers two questions here — where
 * does this button go, and can it be pressed — so the row saying where it
 * leads and the button that runs it can never disagree about it.
 */
function entryLeads(block: SnapshotBlock): Leads[] {
  if (!block.architecture) return [];
  const blocks = requireSnapshot().blocks;

  return block.exposes.flatMap((entry) => {
    const rest = entry.route.slice(1).map((step) => ({ block: blocks[step.path]!, entry: step.entry }));
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

function blockPanel(panel: HTMLElement, block: SnapshotBlock): void {
  const { head, badges } = blockHead(block);
  // Which version the block is on, from the list its Versions section reads,
  // so it is seen without scrolling to the bottom of the panel.
  badges.append(versionBadge(block));

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

  panel.append(...blockAbout(block));

  const problems = problemsSection(requireSnapshot().diagnostics.filter((d) => d.blockPath === block.path), false);
  if (problems) panel.append(problems);

  // What the person and the agent have asked each other about the block comes
  // before what the block is, because it is what is waiting to be done.
  panel.append(notesSection(block));

  // What changed about it since the person last looked comes next, and only
  // while something did, so an unchanged block's panel stays as it was.
  const changed = blockChangesSection(block);
  if (changed) panel.append(changed);

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
  if (ui.selectedLink === STEP_LINK && stepPage(panel, { noteOn, openCode: (p, t) => void openCodeAt(p, t), problemsListed: true })) return;

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
    // Exactly two blocks picked out together are what a rule is between.
    // The offer writes through the kernel, so it is mounted here, beside
    // multiPanel, which stays free of anything that talks to main.
    if (ui.selection.size === 2) {
      const [firstPath, secondPath] = [...ui.selection];
      const first = ui.snapshot?.blocks[firstPath!];
      const second = ui.snapshot?.blocks[secondPath!];
      if (first && second) panel.insertBefore(ruleOffers(first, second), panel.lastElementChild);
    }
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

  // The person's rules, right under the problems a broken one joins. A
  // project with none shows nothing here.
  const rules = rulesSection();
  if (rules) panel.append(rules);

  panel.append(projectNotesSection());
  panel.append(projectChangesSection());

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
