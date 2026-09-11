import type { ProjectLoad } from "../ipc.js";
import { requireSnapshot, ui } from "./state.js";
import {
  fitToView,
  fitWhenReady,
  graphInView,
  onCanvasChange,
  openDiagram,
  renderCanvas,
  resetLayout,
  setUpCanvasGestures,
  showBlock,
  showCanvasMessage,
  watchCanvasSize,
  zoomAbout,
} from "./canvas.js";
import { onInspectorChange, renderInspector } from "./inspector.js";
import { onBenchChange } from "./bench.js";
import { PROJECT_VIEW } from "./graph.js";

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

/* -------------------------------------------------------------------------- */
/* Opening projects                                                            */
/* -------------------------------------------------------------------------- */

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
  ui.waiting = !load.hasManifest;
  ui.loadError = load.error;
  document.body.dataset.project = "open";

  if (fresh) {
    ui.edits.clear();
    ui.benchInputs.clear();
    ui.runs.clear();
    ui.caseResults.clear();
    ui.status = null;
  }

  if (!load.snapshot) {
    // A project that stops reading halfway through a change keeps its last
    // good diagram on screen, with the reason shown over it, until the next
    // change puts it right.
    if (fresh || !load.hasManifest) ui.snapshot = null;
    render();
    return;
  }

  const firstSight = fresh || ui.snapshot === null;
  ui.snapshot = load.snapshot;

  if (firstSight) {
    ui.view = load.snapshot.systems.length > 1 ? PROJECT_VIEW : (load.snapshot.systems[0]?.rootBlock ?? PROJECT_VIEW);
    ui.selection.clear();
    ui.selectedBus = null;
    ui.userAdjusted = false;
  } else if (ui.view !== PROJECT_VIEW && !load.snapshot.blocks[ui.view]) {
    // The diagram that was on screen no longer exists.
    ui.view = PROJECT_VIEW;
    ui.selection.clear();
    ui.selectedBus = null;
  }

  render();
  // Keep whatever the agent added in view, unless the person has arranged the view themselves.
  if (!ui.userAdjusted) fitWhenReady(20);
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
  const result = await window.fragmentor.newProject();
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

  const { written, problems } = result.value;
  const summary = written.length === 0
    ? "Everything was already up to date."
    : `Updated ${written.length} file${written.length === 1 ? "" : "s"}.`;
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
  start.title = "Choose an empty folder, then open your coding agent in it";
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
  if (ui.showInspector) columns.push("360px");

  element("panes").style.gridTemplateColumns = columns.join(" ");
  element("rail").hidden = !ui.showRail;
  element("inspector-pane").hidden = !ui.showInspector;
  element("toggle-rail").setAttribute("aria-pressed", String(ui.showRail));
  element("toggle-inspector").setAttribute("aria-pressed", String(ui.showInspector));
}

function renderCrumbs(): void {
  const nav = element("crumbs");
  nav.replaceChildren();
  if (!ui.snapshot) return;

  const snapshot = requireSnapshot();
  const projectCrumb = el("button", "crumb", snapshot.name);
  projectCrumb.setAttribute("aria-current", String(ui.view === PROJECT_VIEW));
  if (ui.view !== PROJECT_VIEW) projectCrumb.addEventListener("click", () => openDiagram(PROJECT_VIEW));
  nav.append(projectCrumb);

  if (ui.view === PROJECT_VIEW) return;

  const parts = ui.view.split("/");
  parts.forEach((part, i) => {
    nav.append(el("span", "crumb-sep", "/"));
    const path = parts.slice(0, i + 1).join("/");
    const button = el("button", "crumb", part);
    const isCurrent = i === parts.length - 1;
    button.setAttribute("aria-current", String(isCurrent));
    if (!isCurrent) button.addEventListener("click", () => openDiagram(path));
    nav.append(button);
  });
}

function renderTree(): void {
  const tree = element("tree");
  tree.replaceChildren();
  if (!ui.snapshot) return;

  const snapshot = requireSnapshot();
  const walk = (path: string, depth: number) => {
    const block = snapshot.blocks[path];
    if (!block) return;

    const button = el("button", "node");
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-selected", String(path === ui.view));
    button.style.paddingLeft = `${8 + depth * 14}px`;
    button.append(el("span", "glyph", block.kind === "composite" ? "▣" : "▫"), el("span", "label", block.id));

    // A system root says what language it is, since that is what differs.
    if (depth === 0) {
      const system = snapshot.systems.find((entry) => entry.rootBlock === block.id);
      if (system) button.append(el("span", "lang", system.displayName));
    }

    button.addEventListener("click", () => showBlock(path));

    tree.append(button);
    for (const child of block.children) walk(child.path, depth + 1);
  };

  for (const system of snapshot.systems) walk(system.rootBlock, 0);
}

function renderStatus(): void {
  const bar = element("status");
  bar.replaceChildren();

  const stat = (label: string, value: string | number, tone?: string) => {
    const span = el("span", tone);
    span.append(document.createTextNode(`${label} `), el("b", undefined, String(value)));
    return span;
  };

  if (!ui.snapshot) {
    if (!ui.dir) {
      bar.append(el("span", undefined, "No project open"));
    } else {
      bar.append(el("span", "project-name", ui.dir));
      bar.append(el("span", undefined, ui.waiting ? "waiting for the agent to define the system" : "could not be read"));
    }
  } else {
    const snapshot = ui.snapshot;
    const all = Object.values(snapshot.blocks);
    const composites = all.filter((b) => b.kind === "composite").length;
    const implemented = all.filter((block) => block.implemented).length;
    const graph = graphInView();
    const errors = snapshot.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = snapshot.diagnostics.length - errors;

    bar.append(el("span", "project-name", snapshot.name));
    bar.append(el("span", undefined, snapshot.systems.map((system) => `${system.rootBlock} (${system.displayName})`).join("  ")));
    bar.append(stat("blocks", all.length));
    bar.append(stat("composite", composites));
    bar.append(stat("implemented", implemented, implemented === all.length ? "good" : "warn"));
    if (graph) bar.append(stat("buses in view", graph.buses.size));
    bar.append(stat("errors", errors, errors > 0 ? "bad" : undefined));
    bar.append(stat("warnings", warnings, warnings > 0 ? "warn" : undefined));
  }

  if (ui.status) {
    const message = el("span", `message ${ui.status.tone}`, ui.status.text);
    message.style.marginLeft = "auto";
    bar.append(message);
  }
}

/** What the canvas says when a folder is open but there is no diagram to draw. */
function noDiagramText(): string {
  if (ui.waiting) {
    return [
      "No system has been defined here yet.",
      "",
      "Open your coding agent (Claude Code or Codex) in this folder and describe what you want to build:",
      "",
      `  ${ui.dir ?? ""}`,
      "",
      "The agent learns how Fragmentor projects work from FRAGMENTOR.md. The diagram appears here as soon as it writes fragmentor.json.",
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
  renderStatus();
}

export function render(): void {
  renderPanels();
  if (ui.snapshot) renderCanvas();
  else if (ui.dir) showCanvasMessage(noDiagramText());
  renderLoadError();
  renderInspector();
  renderStatus();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

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
  element("generate-code").addEventListener("click", () => void generateCode());
  element("reload-project").addEventListener("click", () => void reload());

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
    fitToView();
  });
  element("layout-reset").addEventListener("click", resetLayout);
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
  // The agent works in the same folder; follow what it does.
  window.fragmentor.onProjectChanged((dir) => {
    if (dir === ui.dir) void reload();
  });
  wireToolbar();
  setUpCanvasGestures();
  watchCanvasSize();
  render();
  void renderWelcome();
} catch (error) {
  reportFailure(error);
  throw error;
}
