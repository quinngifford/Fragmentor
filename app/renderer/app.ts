import type { ProjectLoad } from "../ipc.js";
import {
  COLOUR_BY,
  INSPECTOR_WIDTH,
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
import { askForProjectSettings } from "./newproject.js";
import { onWatchChange, resetWatching, setUpWatching } from "./watch.js";
import { onExecutionChange, paintExecution, resetExecutions, setUpExecutions, showStep } from "./execution.js";
import { closeWindow, openBlockWindow, setUpWindows } from "./popup.js";

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
  ui.edits.clear();
  ui.benchInputs.clear();
  ui.runs.clear();
  ui.caseResults.clear();
  ui.caseNames.clear();
  ui.status = null;
  ui.selection.clear();
  ui.selectedLink = null;
  // A run, and the places runs pause, belong to the project they were set in.
  resetWatching();
  // So does the execution being stepped through, and anything folded away.
  resetExecutions();
  closeWindow();
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
  if (result.value) show(result.value, true);
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

async function reload(): Promise<void> {
  const dir = ui.dir;
  if (!dir) return;

  const ticket = ++latestRead;
  const result = await window.fragmentor.readProject(dir);
  if (ticket !== latestRead || ui.dir !== dir) return;

  if (!result.ok) {
    // The folder itself could not be read, which is not the same as waiting
    // for an agent to write into it.
    ui.waiting = false;
    ui.loadError = result.error;
    render();
    return;
  }
  show(result.value, false);
}

async function generateCode(): Promise<void> {
  const snapshot = ui.snapshot;
  if (!snapshot) return;

  const result = await window.fragmentor.emitCode(snapshot.dir);
  if (!result.ok) {
    ui.status = { text: `Code generation failed: ${result.error}`, tone: "bad" };
    render();
    return;
  }

  const { written, removed, problems } = result.value;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const changes: string[] = [];
  if (written.length > 0) changes.push(`Updated ${count(written.length, "file")}`);
  // A block that has become planned has no code, so what was generated for it goes.
  if (removed.length > 0) changes.push(`took away ${count(removed.length, "file")} the plan no longer needs`);
  const summary = changes.length === 0 ? "Everything was already up to date." : `${changes.join(", ")}.`;
  ui.status = problems.length > 0 ? { text: problems[0]!, tone: "bad" } : { text: summary, tone: "good" };

  await reload();
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

  // Only worth offering with something open to close.
  element("close-project").hidden = !ui.dir;
  // A visual project's code is the person's own, so there is nothing to generate.
  element("generate-code").hidden = ui.snapshot?.mode !== "structured";
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
    bar.append(el("span", `mode-tag ${snapshot.mode}`, snapshot.mode));
    bar.append(el("span", undefined, snapshot.systems.map((system) => `${system.rootBlock}${system.displayName ? ` (${system.displayName})` : ""}`).join("  ")));
    bar.append(stat("blocks", all.length));
    bar.append(
      stat(
        snapshot.mode === "visual" ? "linked to code" : "implemented",
        `${implemented}/${code.length}`,
        implemented === code.length ? "good" : "warn",
      ),
    );
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
 * What to ask the agent for, in the words of the project the person just made.
 *
 * They answered where they were starting from and whether to plan first when
 * they created it, so these first instructions say what to do in that one
 * case rather than listing every case and leaving them to work out which is
 * theirs. `headline` names what is missing, `ask` is the sentence they act on,
 * and `note` says what to expect next.
 */
function firstInstructions(): { headline: string; ask: string; note: string } {
  const snapshot = ui.snapshot;
  const existingCode = snapshot?.existingCode ?? false;
  const planFirst = snapshot?.start === "plan";

  if (snapshot?.mode === "visual") {
    return {
      headline: "Nothing has been drawn yet.",
      ask: existingCode
        ? "Open your coding agent (Claude Code or Codex) in this folder and ask it to map the code into a Fragmentor diagram:"
        : planFirst
          ? "Open your coding agent (Claude Code or Codex) in this folder, describe what you want built, and ask it to draw the shape of it before it writes anything:"
          : "Open your coding agent (Claude Code or Codex) in this folder and describe what you want built. It writes the program however suits it best and keeps the diagram describing what it wrote:",
      note: "It learns how from FRAGMENTOR.md, and it never changes the code. The diagram appears here as soon as it defines the first system.",
    };
  }

  if (existingCode) {
    return {
      headline: "No system has been defined here yet.",
      ask: "Open your coding agent (Claude Code or Codex) in this folder and ask it to rebuild this code as blocks. Commit the code first: it is genuinely rewritten.",
      note: "It learns how this project works from FRAGMENTOR.md. The diagram appears here as soon as it defines the first system.",
    };
  }

  return {
    headline: "No system has been defined here yet.",
    ask: planFirst
      ? "Open your coding agent (Claude Code or Codex) in this folder and describe what you want to build. It draws the whole architecture first, greyed out, for you to agree to before it writes any code:"
      : "Open your coding agent (Claude Code or Codex) in this folder and describe what you want to build:",
    note: planFirst
      ? "It learns how this project works from FRAGMENTOR.md. The planned blocks appear here as soon as it defines the first system, and fill in as you agree to them and it builds them."
      : "It learns how this project works from FRAGMENTOR.md. The diagram appears here as soon as it defines the first system, and fills in as it builds.",
  };
}

/** What the canvas says when a folder is open but there is no diagram to draw. */
function noDiagramText(): string {
  if (ui.waiting) {
    const { headline, ask, note } = firstInstructions();
    return [headline, "", ask, "", `  ${ui.dir ?? ""}`, "", note].join("\n");
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

function wireToolbar(): void {
  element("toggle-rail").addEventListener("click", () => {
    ui.showRail = !ui.showRail;
    renderPanes();
  });
  element("toggle-inspector").addEventListener("click", () => {
    ui.showInspector = !ui.showInspector;
    renderPanes();
  });
  element("new-project").addEventListener("click", () => void newProject());
  element("open-project").addEventListener("click", () => void chooseProject());
  element("close-project").addEventListener("click", () => void closeProject());
  element("generate-code").addEventListener("click", () => void generateCode());
  element("reload-project").addEventListener("click", () => void reload());

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
  // A run being watched moves on by itself; the panels follow it.
  onWatchChange(renderPanels);
  // Picking an execution can change what the diagram draws.
  onExecutionChange(render);
  // The agent works in the same folder; follow what it does.
  window.fragmentor.onProjectChanged((dir) => {
    if (dir === ui.dir) void reload();
  });
  wireToolbar();
  setUpSplitter();
  setUpCanvasGestures();
  watchCanvasSize();
  setUpWatching();
  setUpWindows();
  setUpExecutions();
  onBlockWindow(openBlockWindow);
  // Clicking the step drawn on the tree asks about that step.
  onStepPicked(() => {
    showStep();
    render();
  });
  render();
  void renderWelcome();
} catch (error) {
  reportFailure(error);
  throw error;
}
