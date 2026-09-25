import type { MenuCommand, ProjectLoad } from "../ipc.js";
import { firstStep } from "../../src/codegen/commands.js";
import {
  COLOUR_BY,
  INSPECTOR_WIDTH,
  forgetBlocks,
  rememberInspectorWidth,
  requireSnapshot,
  roleColours,
  selectedBlock,
  ui,
  viewSettings,
} from "./state.js";
import type { ColourBy } from "./state.js";
import {
  applyDependencies,
  clearCanvas,
  onBlockWindow,
  onNotesPicked,
  onStepPicked,
  fitToView,
  fitWhenReady,
  onCanvasChange,
  renderCanvas,
  resetArrivals,
  revealBlock,
  setUpCanvasGestures,
  showCanvasMessage,
  treeInView,
  watchCanvasSize,
  zoomAbout,
} from "./canvas.js";
import { onInspectorChange, renderInspector } from "./inspector.js";
import { onBenchChange } from "./bench.js";
import { askForProjectSettings, showFirstSteps } from "./newproject.js";
import { onWatchChange, resetWatching, setUpWatching } from "./watch.js";
import { onExecutionChange, paintExecution, resetExecutions, setUpExecutions, showStep } from "./execution.js";
import { closeWindow, onLinesNoted, openBlockWindow, setUpWindows } from "./popup.js";
import { benchWindowIsOpen, closeBenchWindow, onBenchWindowChange, renderBenchWindow } from "./benchpanel.js";
import { forgetVersions, onVersionsChange, refreshVersions } from "./versions.js";
import { forgetNotes, noteOn, onNotesChange, openCommandsWindow, renderNotesBar, showNotesOf } from "./notes.js";

/** The shell: panels, hierarchy, breadcrumbs, toolbar and status. */

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The interface is missing #${id}.`);
  return found as T;
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

/**
 * The blocks the hierarchy showed last time, so that one the agent adds stands
 * out wherever it is. Null just after a project is opened, when nothing on
 * screen is new to the person.
 */
let treeBefore: Set<string> | null = null;

/* -------------------------------------------------------------------------- */
/* Opening projects                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything the window was holding about one project. Forgotten whenever a
 * different project takes its place, and when one is put away.
 */
function forgetProject(): void {
  forgetBlocks(null);
  forgetVersions();
  forgetNotes();
  ui.status = null;
  ui.selection.clear();
  ui.selectedLink = null;
  // A run, and the places runs pause, belong to the project they were set in.
  resetWatching();
  // So does the execution being stepped through, and anything folded away.
  resetExecutions();
  closeWindow();
  closeBenchWindow();
}

/**
 * Shows what was read from a project folder. `opening` is true when the
 * person chose the folder, and false when it is being read again because
 * something changed it on disk — usually the agent.
 */
function show(load: ProjectLoad, opening: boolean): void {
  const fresh = opening || ui.dir !== load.dir;

  // A change that leaves the project exactly as shown is not worth a redraw,
  // which would take the focus from whatever the person was doing.
  const unchanged =
    !fresh &&
    load.snapshot !== null &&
    ui.snapshot !== null &&
    load.error === ui.loadError &&
    JSON.stringify(load.snapshot) === JSON.stringify(ui.snapshot);
  if (unchanged) return;

  ui.dir = load.dir;
  ui.loadError = load.error;
  document.body.dataset.project = "open";

  if (fresh) {
    forgetProject();

    // In a project the agent has not started on, everything it writes is new
    // and arrives as it is written. In any other, what is there already is
    // simply there.
    const empty = load.snapshot === null || load.snapshot.systems.length === 0;
    resetArrivals(empty);
    treeBefore = empty ? new Set() : null;
  }

  if (!load.snapshot) {
    // A project that stops reading halfway through a change keeps its last
    // good diagram on screen, with the reason shown over it, until the next
    // change puts it right.
    if (fresh) {
      ui.snapshot = null;
      ui.waiting = false;
    }
    render();
    return;
  }

  // The person has set the project up, and the agent has not defined a system yet.
  ui.waiting = load.snapshot.systems.length === 0;
  // The canvas then names a command to send the agent first, which a project
  // started before that command existed has to have explained to its agent.
  if (ui.waiting && fresh) void window.fragmentor.refreshAgentFiles(load.dir);

  const firstSight = fresh || ui.snapshot === null || ui.snapshot.systems.length === 0;
  ui.snapshot = load.snapshot;

  if (firstSight) {
    ui.selection.clear();
    ui.selectedLink = null;
    ui.userAdjusted = false;
  } else {
    // Whatever was picked out, or folded away, may be gone from the project.
    for (const path of [...ui.selection]) if (!load.snapshot.blocks[path]) ui.selection.delete(path);
    for (const path of [...ui.folded]) if (!load.snapshot.blocks[path]) ui.folded.delete(path);
  }

  render();
  // Keep whatever the agent added in view, unless the person has arranged the
  // view themselves. Once the diagram is on screen, it eases over rather than jumping.
  if (!ui.userAdjusted) {
    if (firstSight) fitWhenReady(20);
    else fitToView(true);
  }
}

async function chooseProject(): Promise<void> {
  const result = await window.fragmentor.chooseProject();
  if (!result.ok) {
    ui.status = { text: result.error, tone: "bad" };
    render();
    return;
  }
  if (result.value) show(result.value, true);
}

async function newProject(): Promise<void> {
  const settings = await askForProjectSettings();
  if (!settings) return;

  const result = await window.fragmentor.newProject(settings);
  if (!result.ok) {
    ui.status = { text: `Could not start a project there: ${result.error}`, tone: "bad" };
    render();
    return;
  }
  if (!result.value) return;
  show(result.value, true);
  // Where the folder turned out to disagree with an answer, what was written
  // down is what the agent will be told, so that is what the first step follows.
  showFirstSteps(result.value.snapshot ?? settings, result.value.dir);
}

async function openPath(dir: string): Promise<void> {
  const result = await window.fragmentor.loadProject(dir);
  if (!result.ok) {
    ui.status = { text: `Could not open ${dir}: ${result.error}`, tone: "bad" };
    render();
    return;
  }
  show(result.value, true);
}

/**
 * Puts the project away and shows the start screen again. Nothing is written:
 * closing is only about this window, and everything the project holds — its
 * layout, its tests, its code — is already on disk.
 */
async function closeProject(): Promise<void> {
  if (!ui.dir) return;

  // Stop hearing about a folder no longer on screen, so a busy agent working
  // in it cannot pull a closed project back up.
  latestRead += 1;
  await window.fragmentor.closeProject();

  forgetProject();
  ui.dir = null;
  ui.snapshot = null;
  ui.loadError = null;
  ui.waiting = false;
  ui.userAdjusted = false;
  treeBefore = null;

  clearCanvas();
  delete document.body.dataset.project;
  render();
  // The project just closed is now the most recent one, so the list is read again.
  void renderWelcome();
}

/** Changes arrive in bursts, so only the most recent read may update the screen. */
let latestRead = 0;

/** Reads the project again. False when it showed nothing: no project is open, or a later read or another project took its place. */
async function reload(): Promise<boolean> {
  const dir = ui.dir;
  if (!dir) return false;

  const ticket = ++latestRead;
  const result = await window.fragmentor.readProject(dir);
  if (ticket !== latestRead || ui.dir !== dir) return false;

  if (!result.ok) {
    // The folder itself could not be read, which is not the same as waiting
    // for an agent to write into it.
    ui.waiting = false;
    ui.loadError = result.error;
    render();
    return true;
  }
  show(result.value, false);
  return true;
}

/**
 * Reload Project, from the menu. A project that has not changed looks just
 * the same afterwards, so it says it was read, unless reading it failed,
 * which says so itself.
 */
async function reloadByHand(): Promise<void> {
  if (!(await reload())) return;
  if (!ui.loadError) ui.status = { text: "Read the project again from disk.", tone: "good" };
  render();
}

/* -------------------------------------------------------------------------- */
/* Welcome                                                                     */
/* -------------------------------------------------------------------------- */

async function renderWelcome(): Promise<void> {
  const panel = element("welcome-body");
  panel.replaceChildren();

  const actions = el("div", "welcome-actions");
  const start = el("button", "btn", "New project…");
  start.title = "Start a project in a folder, empty or holding code, then open your coding agent in it";
  start.addEventListener("click", () => void newProject());
  const open = el("button", "btn quiet", "Open a project folder…");
  open.addEventListener("click", () => void chooseProject());
  actions.append(start, open);
  panel.append(actions);

  const examples = await window.fragmentor.exampleProjects();
  if (examples.ok && examples.value.length > 0) {
    const group = el("div", "welcome-group");
    group.append(el("h3", undefined, "Examples"));
    for (const example of examples.value) {
      const button = el("button", "welcome-link", example.name);
      button.addEventListener("click", () => void openPath(example.dir));
      group.append(button);
    }
    panel.append(group);
  }

  const recent = await window.fragmentor.recentProjects();
  if (recent.ok && recent.value.length > 0) {
    const group = el("div", "welcome-group");
    group.append(el("h3", undefined, "Recent"));
    for (const dir of recent.value) {
      const button = el("button", "welcome-link", dir);
      button.title = dir;
      button.addEventListener("click", () => void openPath(dir));
      group.append(button);
    }
    panel.append(group);
  }
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

function renderPanes(): void {
  const columns: string[] = [];
  if (ui.showRail) columns.push("232px");
  columns.push("minmax(0, 1fr)");
  if (ui.showInspector) columns.push("5px", `${Math.round(ui.inspectorWidth)}px`);

  element("panes").style.gridTemplateColumns = columns.join(" ");

  const handle = element("inspector-splitter");
  handle.setAttribute("aria-valuenow", String(Math.round(ui.inspectorWidth)));
  handle.setAttribute("aria-valuemin", String(INSPECTOR_WIDTH.least));
  handle.setAttribute("aria-valuemax", String(INSPECTOR_WIDTH.most));

  element("rail").hidden = !ui.showRail;
  element("inspector-pane").hidden = !ui.showInspector;
  element("inspector-splitter").hidden = !ui.showInspector;
  element("toggle-rail").setAttribute("aria-pressed", String(ui.showRail));
  element("toggle-inspector").setAttribute("aria-pressed", String(ui.showInspector));

  // Only worth offering with a project open to ask an agent about.
  element("agent-commands").hidden = !ui.dir;
}

/** Dragging the edge between the diagram and the inspector, or nudging it with the arrow keys. */
function setUpSplitter(): void {
  const handle = element("inspector-splitter");

  const setWidth = (width: number) => {
    ui.inspectorWidth = Math.min(INSPECTOR_WIDTH.most, Math.max(INSPECTOR_WIDTH.least, width));
    renderPanes();
  };

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.dataset.dragging = "true";
    document.body.dataset.resizing = "true";

    // Tracked on the window, as dragging a block is: the pointer leaves the
    // handle the moment it starts moving.
    const move = (at: PointerEvent) => {
      if (at.pointerId === event.pointerId) setWidth(window.innerWidth - at.clientX);
    };
    const stop = (up: PointerEvent) => {
      if (up.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      delete handle.dataset.dragging;
      delete document.body.dataset.resizing;
      rememberInspectorWidth(ui.inspectorWidth);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });

  handle.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
    if (step === 0) return;
    event.preventDefault();
    setWidth(ui.inspectorWidth + step);
    rememberInspectorWidth(ui.inspectorWidth);
  });
}

/** Where the block picked out sits: the project, then each block holding it. */
function renderCrumbs(): void {
  const nav = element("crumbs");
  nav.replaceChildren();
  if (!ui.snapshot || ui.waiting) return;

  const snapshot = requireSnapshot();
  const picked = selectedBlock();
  const projectCrumb = el("button", "crumb", snapshot.name);
  projectCrumb.setAttribute("aria-current", String(picked === null));
  projectCrumb.addEventListener("click", () => {
    ui.selection.clear();
    ui.selectedLink = null;
    render();
  });
  nav.append(projectCrumb);
  if (!picked) return;

  const parts = picked.path.split("/");
  parts.forEach((part, at) => {
    nav.append(el("span", "crumb-sep", "/"));
    const path = parts.slice(0, at + 1).join("/");
    const button = el("button", "crumb", part);
    const isCurrent = at === parts.length - 1;
    button.setAttribute("aria-current", String(isCurrent));
    if (!isCurrent) button.addEventListener("click", () => revealBlock(path));
    nav.append(button);
  });
}

function renderTree(): void {
  const tree = element("tree");
  tree.replaceChildren();
  if (!ui.snapshot) return;

  const snapshot = requireSnapshot();
  const before = treeBefore;
  const shown = new Set<string>();

  const walk = (path: string, depth: number) => {
    const block = snapshot.blocks[path];
    if (!block) return;

    const button = el("button", "node");
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-selected", String(ui.selection.has(path)));
    button.dataset.path = path;
    button.style.paddingLeft = `${8 + depth * 14}px`;
    // A block that is not code gets its own mark, so the rail says what kind
    // of thing each part of the system is at a glance.
    button.append(
      el("span", "glyph", block.architecture ? "◈" : block.children.length > 0 ? "▣" : "▫"),
      el("span", "label", block.id),
    );
    if (block.architecture) {
      button.dataset.architecture = "true";
      button.dataset.role = block.role;
    }
    if (before && !before.has(path)) button.classList.add("appearing");
    shown.add(path);

    // A system root says what language it is, since that is what differs.
    if (depth === 0) {
      const system = snapshot.systems.find((entry) => entry.rootBlock === block.id);
      if (system?.displayName) button.append(el("span", "lang", system.displayName));
    }

    button.addEventListener("click", () => revealBlock(path));

    tree.append(button);
    for (const child of block.children) walk(child, depth + 1);
  };

  for (const system of snapshot.systems) walk(system.rootBlock, 0);
  treeBefore = shown;
}

function renderStatus(): void {
  const bar = element("status");
  bar.replaceChildren();

  const stat = (label: string, value: string | number, tone?: string) => {
    const span = el("span", tone);
    span.append(document.createTextNode(`${label} `), el("b", undefined, String(value)));
    return span;
  };

  if (!ui.snapshot || ui.waiting) {
    if (!ui.dir) {
      bar.append(el("span", undefined, "No project open"));
    } else {
      bar.append(el("span", "project-name", ui.dir));
      bar.append(el("span", undefined, ui.waiting ? "waiting for the agent to define the system" : "could not be read"));
    }
  } else {
    const snapshot = ui.snapshot;
    const all = Object.values(snapshot.blocks);
    // Only functions can be implemented, so only they are counted. A database
    // is not unfinished work, and neither is a group of parts.
    const code = all.filter((block) => !block.architecture);
    const architecture = all.length - code.length;
    const implemented = code.filter((block) => block.implemented).length;
    const shown = treeInView()?.nodes.size ?? all.length;
    const errors = snapshot.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = snapshot.diagnostics.length - errors;

    bar.append(el("span", "project-name", snapshot.name));
    bar.append(el("span", undefined, snapshot.systems.map((system) => `${system.rootBlock}${system.displayName ? ` (${system.displayName})` : ""}`).join("  ")));
    bar.append(stat("blocks", all.length));
    bar.append(
      stat("code found", `${implemented}/${code.length}`, implemented === code.length ? "good" : "warn"),
    );
    // How much of the code Fragmentor holds to a contract, and so checks and
    // runs, rather than only draws.
    const held = code.filter((block) => block.runnable).length;
    if (held > 0) bar.append(stat("checked", `${held}/${code.length}`, held === code.length ? "good" : undefined));
    if (architecture > 0) bar.append(stat("architecture", architecture));
    // Folding is the one thing that takes blocks off the tree, so it is the
    // one thing worth saying about what is on screen.
    if (shown < all.length) bar.append(stat("folded away", all.length - shown));
    bar.append(stat("errors", errors, errors > 0 ? "bad" : undefined));
    bar.append(stat("warnings", warnings, warnings > 0 ? "warn" : undefined));
  }

  if (ui.status) {
    const message = el("span", `message ${ui.status.tone}`, ui.status.text);
    message.style.marginLeft = "auto";
    bar.append(message);
  }
}

/**
 * What the canvas says when a folder is open but there is no diagram to draw.
 *
 * While the agent has not started, that is what to send it first. The person
 * answered where they were starting from and whether to plan first when they
 * created the project, so it names the one command for that case rather than
 * listing every case and leaving them to work out which is theirs.
 */
function noDiagramText(): string {
  if (ui.waiting) {
    const existingCode = ui.snapshot?.existingCode ?? false;
    const { command, phrase, happens, next } = firstStep(existingCode, ui.snapshot?.start ?? "build");
    return [
      existingCode ? "Nothing has been drawn yet." : "No system has been defined here yet.",
      "",
      "Open your coding agent (Claude Code or Codex) in this folder:",
      "",
      `  ${ui.dir ?? ""}`,
      "",
      command.takes === "words" ? "and send it this first, describing what you want to build where the angle brackets are:" : "and send it this first:",
      "",
      `  ${phrase}`,
      "",
      `${happens} It learns how from FRAGMENTOR.md, and the diagram appears here as soon as it defines the first system.`,
      ...(next ? ["", "When you agree to the plan, send it:", "", `  ${next}`] : []),
      "",
      "Everything else you can ask it is under Commands, at the top right.",
    ].join("\n");
  }
  return [
    "This project could not be read.",
    "",
    ui.loadError ?? "No reason was given.",
    "",
    "Fragmentor is watching the folder and will try again when a file in it changes.",
  ].join("\n");
}

function renderLoadError(): void {
  const banner = element("load-error");
  const showing = Boolean(ui.snapshot && ui.loadError);
  banner.hidden = !showing;
  banner.textContent = showing
    ? `The latest change could not be read, so this is the last version that could.\n\n${ui.loadError}`
    : "";
}

/** Everything except the diagram, which keeps its elements between clicks. */
function renderPanels(): void {
  renderPanes();
  renderCrumbs();
  renderTree();
  renderInspector();
  renderBenchWindow();
  renderNotesBar();
  renderStatus();
}

export function render(): void {
  renderPanels();
  if (ui.snapshot && !ui.waiting) renderCanvas();
  else if (ui.dir) showCanvasMessage(noDiagramText());
  // Whichever diagram is on screen now, or none.
  paintExecution();
  renderLoadError();
  renderInspector();
  renderStatus();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a colour on the diagram means. The button says which way it is
 * showing now and moves to the other when it is pressed, so nothing has to be
 * opened to find out which way round it is.
 */
function wireViewSettings(): void {
  const labels: Record<ColourBy, string> = {
    block: "Colour: by block",
    role: "Colour: by kind",
  };

  const colour = element("colour-by");
  const show = () => {
    colour.textContent = labels[viewSettings.colourBy];
  };

  colour.addEventListener("click", () => {
    const at = COLOUR_BY.indexOf(viewSettings.colourBy);
    viewSettings.setColourBy(COLOUR_BY[(at + 1) % COLOUR_BY.length]!);
    show();
    render();
  });

  // What each block reaches is a standing fact rather than something that
  // happened, and can be put away to leave the blocks, or an execution, alone.
  const dependencies = element("show-dependencies");
  const showDependencies = () => {
    dependencies.textContent = ui.showDependencies ? "Dependencies: shown" : "Dependencies: hidden";
    dependencies.setAttribute("aria-pressed", String(ui.showDependencies));
  };
  dependencies.addEventListener("click", () => {
    ui.setShowDependencies(!ui.showDependencies);
    showDependencies();
    applyDependencies();
  });

  show();
  showDependencies();
}

/** The commands for the agent, with the block picked out, if there is one, filled in. */
async function showCommands(): Promise<void> {
  openCommandsWindow(selectedBlock()?.path ?? null);
}

/** What the application menu hands the window: which project is open, and what to ask its agent. */
function wireMenu(): void {
  const actions: Record<MenuCommand, () => Promise<void>> = {
    "new-project": newProject,
    "open-project": chooseProject,
    "close-project": closeProject,
    "reload-project": reloadByHand,
    "show-commands": showCommands,
  };
  window.fragmentor.onMenuCommand((command) => {
    // A shortcut pressed while a dialog is up would start a second thing on
    // top of the one the person is answering, so it is let go.
    if (document.querySelector("dialog[open]")) return;
    void actions[command]?.();
  });
}

function wireToolbar(): void {
  element("toggle-rail").addEventListener("click", () => {
    ui.showRail = !ui.showRail;
    renderPanes();
  });
  element("toggle-inspector").addEventListener("click", () => {
    ui.showInspector = !ui.showInspector;
    renderPanes();
  });
  element("agent-commands").addEventListener("click", () => void showCommands());

  // The chosen colours go onto the document itself, so every block, line,
  // badge and swatch of a kind follows from one place.
  roleColours.apply();
  wireViewSettings();

  element("zoom-in").addEventListener("click", () => {
    const rect = element("canvas-svg").getBoundingClientRect();
    zoomAbout(rect.width / 2, rect.height / 2, 1.2);
  });
  element("zoom-out").addEventListener("click", () => {
    const rect = element("canvas-svg").getBoundingClientRect();
    zoomAbout(rect.width / 2, rect.height / 2, 1 / 1.2);
  });
  element("zoom-fit").addEventListener("click", () => {
    ui.userAdjusted = false;
    fitToView(true);
  });
}

function reportFailure(error: unknown): void {
  const wrap = document.getElementById("canvas-wrap");
  if (!wrap) return;
  const note = el("pre", "canvas-empty boot-error");
  note.textContent = `Something went wrong.\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  wrap.append(note);
}

try {
  // A selection or a drag updates the panels only: rebuilding the diagram
  // would replace the element the gesture is happening on.
  onCanvasChange(({ redraw }) => (redraw ? render() : renderPanels()));
  onInspectorChange(render);
  onBenchChange(render);
  onBenchWindowChange(render);
  // A run being watched moves on by itself; the panels follow it.
  onWatchChange(renderPanels);
  // Stepping changes what is laid over the drawing; only a different
  // drawing, or blocks unfolded, is a reason to build it again.
  onExecutionChange(({ redraw }) => (redraw ? render() : renderPanels()));
  // A swap rewrites the project; show it now rather than when the watcher next hears.
  // A read overtaken by a later one is not drawn: what is on screen may still
  // be from before the swap, and drawing it would fill the bench again with
  // what forgetBlocks just took away. The later read shows what is there.
  onVersionsChange({
    all: render,
    reload: async () => {
      if (await reload()) render();
    },
  });
  // A note written from the window is shown at once, rather than when the watcher next hears.
  onNotesChange({
    all: render,
    reload: async () => {
      await reload();
    },
  });
  // The agent works in the same folder; follow what it does.
  window.fragmentor.onProjectChanged((dir) => {
    if (dir === ui.dir) void reload().then(refreshVersions);
  });
  // An agent's commit touches only .git, which nothing watches, so the list of
  // versions on screen is read again whenever the person comes back to it.
  window.addEventListener("focus", () => void refreshVersions());
  wireToolbar();
  wireMenu();
  setUpSplitter();
  setUpCanvasGestures();
  watchCanvasSize();
  setUpWatching();
  setUpWindows(() => {
    closeBenchWindow();
    render();
  });
  setUpExecutions();
  onBlockWindow(openBlockWindow);
  // The count on a block's corner leads to the notes it counts.
  onNotesPicked(showNotesOf);
  // Lines picked out in a block's code start a note on them.
  onLinesNoted(noteOn);
  // Clicking the step drawn on the tree asks about that step.
  onStepPicked(() => {
    showStep();
    renderPanels();
  });
  render();
  void renderWelcome();
} catch (error) {
  reportFailure(error);
  throw error;
}
