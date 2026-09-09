import type { ProjectSnapshot } from "../../src/project/snapshot.js";
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
  watchCanvasSize,
  zoomAbout,
} from "./canvas.js";
import { onInspectorChange, renderInspector } from "./inspector.js";
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

function adopt(snapshot: ProjectSnapshot): void {
  ui.snapshot = snapshot;
  ui.view = snapshot.systems.length > 1 ? PROJECT_VIEW : (snapshot.systems[0]?.rootBlock ?? PROJECT_VIEW);
  ui.selection.clear();
  ui.selectedBus = null;
  ui.edits.clear();
  ui.userAdjusted = false;
  ui.status = null;
  document.body.dataset.project = "open";
  render();
  fitWhenReady(20);
}

async function chooseProject(): Promise<void> {
  const result = await window.fragmentor.chooseProject();
  if (!result.ok) {
    ui.status = { text: result.error, tone: "bad" };
    render();
    return;
  }
  if (result.value) adopt(result.value);
}

async function openPath(dir: string): Promise<void> {
  const result = await window.fragmentor.loadProject(dir);
  if (!result.ok) {
    ui.status = { text: `Could not open ${dir}: ${result.error}`, tone: "bad" };
    render();
    return;
  }
  adopt(result.value);
}

async function reload(): Promise<void> {
  const snapshot = ui.snapshot;
  if (!snapshot) return;
  const view = ui.view;
  const result = await window.fragmentor.loadProject(snapshot.dir);
  if (!result.ok) {
    ui.status = { text: `Could not reload: ${result.error}`, tone: "bad" };
    render();
    return;
  }
  ui.snapshot = result.value;
  ui.view = view === PROJECT_VIEW || result.value.blocks[view] ? view : PROJECT_VIEW;
  render();
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

  const { written, skipped, problems } = result.value;
  ui.status = problems.length > 0
    ? { text: problems[0]!, tone: "bad" }
    : { text: `Generated ${written.length} files, kept ${skipped.length} existing implementations.`, tone: "good" };

  await reload();
}

/* -------------------------------------------------------------------------- */
/* Welcome                                                                     */
/* -------------------------------------------------------------------------- */

async function renderWelcome(): Promise<void> {
  const panel = element("welcome-body");
  panel.replaceChildren();

  const open = el("button", "btn", "Open a project folder…");
  open.addEventListener("click", () => void chooseProject());
  panel.append(open);

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

    button.addEventListener("click", () => {
      if (block.kind === "composite") {
        openDiagram(path);
      } else {
        ui.view = path.split("/").slice(0, -1).join("/") || PROJECT_VIEW;
        ui.selection.clear();
        ui.selection.add(block.id);
        ui.selectedBus = null;
        render();
      }
    });

    tree.append(button);
    for (const child of block.children) walk(child.path, depth + 1);
  };

  for (const system of snapshot.systems) walk(system.rootBlock, 0);
}

function renderStatus(): void {
  const bar = element("status");
  bar.replaceChildren();

  if (!ui.snapshot) {
    bar.append(el("span", undefined, "No project open"));
    return;
  }

  const snapshot = requireSnapshot();
  const all = Object.values(snapshot.blocks);
  const composites = all.filter((b) => b.kind === "composite").length;
  const implemented = all.filter((block) => block.implemented).length;
  const graph = graphInView();
  const errors = snapshot.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = snapshot.diagnostics.length - errors;

  const stat = (label: string, value: string | number, tone?: string) => {
    const span = el("span", tone);
    span.append(document.createTextNode(`${label} `), el("b", undefined, String(value)));
    return span;
  };

  bar.append(el("span", "project-name", snapshot.name));
  bar.append(el("span", undefined, snapshot.systems.map((system) => `${system.rootBlock} (${system.displayName})`).join("  ")));
  bar.append(stat("blocks", all.length));
  bar.append(stat("composite", composites));
  bar.append(stat("implemented", implemented, implemented === all.length ? "good" : "warn"));
  if (graph) bar.append(stat("buses in view", graph.buses.size));
  bar.append(stat("errors", errors, errors > 0 ? "bad" : undefined));
  bar.append(stat("warnings", warnings, warnings > 0 ? "warn" : undefined));

  if (ui.status) {
    const message = el("span", `message ${ui.status.tone}`, ui.status.text);
    message.style.marginLeft = "auto";
    bar.append(message);
  }
}

export function render(): void {
  renderPanes();
  renderCrumbs();
  renderTree();
  if (ui.snapshot) renderCanvas();
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
  const note = el("pre", "canvas-empty");
  note.textContent = `Something went wrong.\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  wrap.append(note);
}

try {
  onCanvasChange(render);
  onInspectorChange(render);
  wireToolbar();
  setUpCanvasGestures();
  watchCanvasSize();
  render();
  void renderWelcome();
} catch (error) {
  reportFailure(error);
  throw error;
}
