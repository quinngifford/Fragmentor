import type { ExportData } from "../exportPage.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { INSPECTOR_WIDTH, requireSnapshot, selectedBlock, ui, useLook } from "./state.js";
import {
  accessArrows,
  fitWhenReady,
  hasCode,
  hasDetails,
  makeLegendReadOnly,
  onBlockWindow,
  onCanvasChange,
  onStepPicked,
  renderCanvas,
  setUpCanvasGestures,
  setUpZoomBar,
  treeInView,
  watchCanvasSize,
} from "./canvas.js";
import { STEP_LINK, keepStepInView, onExecutionChange, paintExecution, setUpExecutions, showStep, stepPage } from "./execution.js";
import { openDetailsWindow, openWindow, setUpWindows } from "./popup.js";
import { accessPanel, blockAbout, blockHead, entryLeads, interfaceSection, measurementsSection, multiPanel, projectHead, reachesSection, routesOf, systemsSection, usedBySection } from "./detail.js";
import { el, element, section } from "./dom.js";

/**
 * The script of an exported page: the project drawn as the window draws it,
 * from the data the page carries, with nothing that edits, runs, records or
 * talks to anything. It is built from the window's own reading modules, so
 * what a reader sees is what the person saw, and the build refuses a bundle
 * that brings in any module that talks to the application.
 */

const data = JSON.parse(element("fragmentor-export").textContent ?? "") as ExportData;

/** The day the page was made, written out in the reader's own way. */
const exportedOn = new Date(`${data.exported}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/** The code a block stands for, as far as the page can say: where it is. The code stays with the project. */
function codeWindow(block: SnapshotBlock): void {
  const body = el("div", "window-sections");
  body.append(el("p", "bench-note", "The code is not part of this page. It stays with the project, at:"));
  body.append(el("pre", "code", block.code?.pointer ?? block.files.code));
  openWindow(block.name, block.path, body);
}

function codeSection(block: SnapshotBlock): HTMLElement | null {
  if (block.planned) {
    const node = section("Code");
    node.append(el("p", "bench-note", "There is none: this block is planned."));
    return node;
  }
  if (block.code === null && block.architecture) return null;
  const node = section("Code");
  if (block.code !== null) node.append(el("pre", "code", block.code.pointer));
  else if (block.files.code !== "") {
    // It names its code, and nothing was there when the page was made.
    node.append(el("pre", "code", block.files.code), el("p", "bench-note", "Nothing was found there when this page was made."));
  } else node.append(el("p", "bench-note", "This block does not say where its code is."));
  return node;
}

function blockPage(panel: HTMLElement, block: SnapshotBlock): void {
  const { head } = blockHead(block, { document: true });
  const windows = el("div", "insp-windows");
  if (hasDetails(block)) {
    const details = el("button", "btn quiet tiny", "Interface");
    details.title = `What ${block.name} can be used through, and what it reaches`;
    details.addEventListener("click", () => openDetailsWindow(block));
    windows.append(details);
  }
  if (hasCode(block)) {
    const code = el("button", "btn quiet tiny", "Code");
    code.title = `Where the code behind ${block.name} is`;
    code.addEventListener("click", () => codeWindow(block));
    windows.append(code);
  }
  if (windows.childElementCount > 0) head.append(windows);
  panel.append(head, ...blockAbout(block));

  panel.append(interfaceSection(block, routesOf(entryLeads(block))));
  const snapshot = requireSnapshot();
  const reaches = reachesSection(block, snapshot);
  if (reaches) panel.append(reaches);
  const usedBy = usedBySection(block, snapshot);
  if (usedBy) panel.append(usedBy);
  const measurements = measurementsSection(block, snapshot);
  if (measurements) panel.append(measurements);
  const code = codeSection(block);
  if (code) panel.append(code);
}

function projectPage(panel: HTMLElement): void {
  const snapshot = requireSnapshot();
  panel.append(...projectHead(snapshot), systemsSection(snapshot));

  const about = section("About this page");
  about.append(
    el(
      "p",
      "bench-note",
      `Exported from Fragmentor on ${exportedOn}. It shows the architecture and the executions the agent wrote down. The code, notes and tests stay with the project.`,
    ),
  );
  const { errors, warnings } = data.problems;
  const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  about.append(
    el(
      "p",
      "bench-note",
      errors + warnings === 0
        ? "No problems were listed when it was exported."
        : `When it was exported, ${[errors > 0 ? counted(errors, "error") : "", warnings > 0 ? counted(warnings, "warning") : ""].filter(Boolean).join(" and ")} ${errors + warnings === 1 ? "was" : "were"} listed. They are not shown here.`,
    ),
  );
  panel.append(about);
}

/** The panel beside the drawing, chosen the way the window's inspector chooses it. */
function renderPage(): void {
  const panel = element("inspector");
  panel.replaceChildren();

  if (ui.selectedLink === STEP_LINK && stepPage(panel, {})) return;

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
  const only = selectedBlock();
  if (only) blockPage(panel, only);
  else projectPage(panel);
}

function renderStatus(): void {
  const bar = element("status");
  bar.replaceChildren(el("span", "project-name", requireSnapshot().name), el("span", undefined, `exported ${exportedOn}`));
  const mark = el("span", undefined, "Made with Fragmentor");
  mark.style.marginLeft = "auto";
  bar.append(mark);
}

function renderPanels(): void {
  renderPage();
  renderStatus();
}

function render(): void {
  renderCanvas();
  paintExecution();
  renderPanels();
}

try {
  ui.snapshot = data.snapshot;
  ui.dir = "";
  ui.waiting = false;
  useLook(data.look);
  makeLegendReadOnly();
  // The panes are the drawing and the panel beside it; nothing moves them.
  element("panes").style.gridTemplateColumns = `minmax(0, 1fr) ${INSPECTOR_WIDTH.standard}px`;

  onCanvasChange(({ redraw }) => (redraw ? render() : renderPanels()));
  onExecutionChange(({ redraw }) => (redraw ? render() : renderPanels()));
  onStepPicked(() => {
    showStep();
    renderPanels();
  });
  onBlockWindow((kind, path) => {
    const block = ui.snapshot?.blocks[path];
    if (!block) return;
    if (kind === "details") openDetailsWindow(block);
    else codeWindow(block);
  });
  setUpCanvasGestures();
  watchCanvasSize();
  setUpZoomBar();
  setUpWindows(() => false);
  // Nothing here can be recorded, so the bar offers only what was written down.
  setUpExecutions(null);
  // An execution picked when the page was made opens on its step.
  if (ui.execution) showStep();

  render();
  // Fitted from the top, as the window opens a project; then the step it was
  // exported on is brought into view, wherever on the drawing it is.
  fitWhenReady(20, keepStepInView);
  document.body.dataset.ready = "true";
} catch (error) {
  const note = el("pre", "canvas-empty boot-error");
  note.textContent = `This page could not be drawn.\n\n${error instanceof Error ? error.message : String(error)}`;
  document.getElementById("canvas-wrap")?.append(note);
  throw error;
}
