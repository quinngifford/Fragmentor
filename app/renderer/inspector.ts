import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { ProjectDiagnostic } from "../../src/project/project.js";
import { BUS_PALETTE, busColors, requireSnapshot, ui } from "./state.js";
import { busColour, connectionCode } from "./graph.js";
import type { Bus, Graph } from "./graph.js";
import { graphInView, openDiagram, showBlock } from "./canvas.js";
import { benchSections } from "./bench.js";

let notify: () => void = () => {};
export function onInspectorChange(callback: () => void): void {
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

/** `major` marks one of the three areas the panel is divided into. */
function section(title: string, major = false): HTMLElement {
  const node = el("section", major ? "section major" : "section");
  node.append(el("h3", undefined, title));
  return node;
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
    const row = el(linked ? "button" : "div", `problem ${diagnostic.severity}`);
    row.append(el("span", "problem-level", diagnostic.severity));
    if (linked) {
      row.append(el("span", "problem-where", diagnostic.blockPath));
      row.title = "Show this block";
      row.addEventListener("click", () => showBlock(diagnostic.blockPath));
    }
    row.append(el("span", "problem-text", diagnostic.message));
    list.append(row);
  }

  node.append(list);
  return node;
}

function portSection(
  title: string,
  ports: { name: string; type?: string; capability?: string; description: string | null }[],
  isCapability = false,
): HTMLElement {
  const node = section(title);
  if (ports.length === 0) {
    node.append(el("p", "bench-note", "None."));
    return node;
  }

  const list = el("div", "ports");
  for (const port of ports) {
    const row = el("div", `port-row${isCapability ? " cap" : ""}`);
    row.append(el("div", "pname", port.name));
    row.append(el("div", "ptype", (isCapability ? port.capability : port.type) ?? ""));
    if (port.description) row.append(el("div", "pdesc", port.description));
    list.append(row);
  }
  node.append(list);
  return node;
}

function codeSection(block: SnapshotBlock): HTMLElement {
  const node = section("Code", true);

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
  const isContract = ui.codeTab === "contract";
  const pending = ui.edits.get(block.path);
  const value = isContract ? onDisk : (pending?.text ?? onDisk);

  if (value === null || value === undefined) {
    node.append(el("p", "bench-note", "This file has not been generated yet. Use Generate code."));
    return node;
  }

  const editor = el("textarea", "code-editor");
  editor.spellcheck = false;
  editor.value = value;
  editor.readOnly = isContract;
  node.append(editor);

  const foot = el("div", "code-foot");

  if (isContract) {
    foot.append(el("p", "bench-note", "Generated from block.json, so it is read-only. Change the diagram and it is rewritten."));
    node.append(foot);
    return node;
  }

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

function blockPanel(panel: HTMLElement, block: SnapshotBlock): void {
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, block.name), el("div", "insp-id", block.path));

  const badges = el("div", "badges");
  const kind = el("span", `badge${block.kind === "composite" ? " composite" : ""}`, block.kind);
  const state = el("span", "badge state", block.implemented ? "implemented" : "specified");
  const language = el("span", "badge", block.language);
  badges.append(kind, state, language);
  head.append(badges);

  if (block.kind === "composite" && block.path !== ui.view) {
    const open = el("button", "btn", "Open diagram");
    open.addEventListener("click", () => openDiagram(block.path));
    head.append(open);
  }
  panel.append(head);

  panel.append(el("p", "responsibility", block.responsibility));

  const problems = problemsSection(requireSnapshot().diagnostics.filter((d) => d.blockPath === block.path), false);
  if (problems) panel.append(problems);

  panel.append(portSection("Inputs", block.inputs));
  panel.append(portSection("Outputs", block.outputs));
  panel.append(portSection("Capabilities", block.capabilities, true));
  panel.append(codeSection(block));
  for (const section of benchSections(block)) panel.append(section);
}

function busPanel(panel: HTMLElement, graph: Graph, bus: Bus): void {
  const sourceLabel = graph.nodes.get(bus.source)?.label ?? bus.source;
  const targetLabel = graph.nodes.get(bus.target)?.label ?? bus.target;

  const head = el("div", "insp-head");
  head.append(
    el("h2", undefined, `${sourceLabel} → ${targetLabel}`),
    el("div", "insp-id", `${bus.signals.length} signal${bus.signals.length === 1 ? "" : "s"} on one bus`),
  );
  panel.append(head);

  const carries = section("Carries");
  const list = el("div", "ports");
  for (const signal of bus.signals) {
    const row = el("div", "port-row");
    row.append(el("div", "pname", `${signal.sourcePort} → ${signal.targetPort}`));
    row.append(el("div", "ptype", signal.type ?? "unknown"));
    list.append(row);
  }
  carries.append(list);
  panel.append(carries);

  const code = section("In code");
  const pre = el("pre", "code", connectionCode(graph, bus));
  code.append(pre);
  code.append(el("p", "bench-note", "The call and binding this connection stands for, derived from the diagram. Open the parent block to read the code that was actually written."));
  panel.append(code);

  const colours = section("Colour");
  const swatches = el("div", "swatches");
  const current = busColour(graph, ui.view, bus);
  for (const colour of BUS_PALETTE) {
    const swatch = el("button", "swatch-btn");
    swatch.style.background = colour;
    swatch.title = colour;
    swatch.setAttribute("aria-pressed", String(colour.toLowerCase() === current.toLowerCase()));
    swatch.addEventListener("click", () => {
      busColors.set(ui.view, bus.id, colour);
      notify();
    });
    swatches.append(swatch);
  }
  colours.append(swatches);

  const reset = el("button", "btn quiet", "Use the default colour");
  reset.style.marginTop = "8px";
  reset.addEventListener("click", () => {
    busColors.set(ui.view, bus.id, null);
    notify();
  });
  colours.append(reset);
  panel.append(colours);
}

function multiPanel(panel: HTMLElement, graph: Graph): void {
  const keys = [...ui.selection];
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, `${keys.length} blocks selected`), el("div", "insp-id", keys.join(", ")));
  panel.append(head);

  const between = [...graph.buses.values()].filter((b) => ui.selection.has(b.source) && ui.selection.has(b.target));
  const node = section("Buses between them");

  if (between.length === 0) {
    node.append(el("p", "bench-note", "These blocks are not directly connected."));
  } else {
    const list = el("div", "ports");
    for (const bus of between) {
      const row = el("div", "port-row");
      row.style.borderLeftColor = busColour(graph, ui.view, bus);
      row.append(el("div", "pname", `${graph.nodes.get(bus.source)?.label} → ${graph.nodes.get(bus.target)?.label}`));
      row.append(el("div", "ptype", bus.signals.map((s) => s.targetPort).join(", ")));
      list.append(row);
    }
    node.append(list);
  }

  panel.append(node);
  panel.append(el("p", "bench-note", "Ctrl-click a block to add or remove it from the selection."));
}

export function renderInspector(): void {
  const panel = document.getElementById("inspector");
  if (!panel) return;
  panel.replaceChildren();

  if (!ui.snapshot) {
    const note = !ui.dir
      ? "Open a project to inspect its blocks."
      : ui.waiting
        ? "There is nothing to inspect until the agent defines the system."
        : "There is nothing to inspect until the project can be read.";
    panel.append(el("p", "bench-note", note));
    return;
  }

  const graph = graphInView();

  if (graph && ui.selectedBus) {
    const bus = graph.buses.get(ui.selectedBus);
    if (bus) {
      busPanel(panel, graph, bus);
      return;
    }
  }

  if (graph && ui.selection.size > 1) {
    multiPanel(panel, graph);
    return;
  }

  if (graph && ui.selection.size === 1) {
    const key = [...ui.selection][0]!;
    const node = graph.nodes.get(key);
    if (node?.block) {
      blockPanel(panel, node.block);
      return;
    }
  }

  const snapshot = requireSnapshot();
  const current = snapshot.blocks[ui.view];
  if (current) {
    blockPanel(panel, current);
    return;
  }

  // Nothing is selected and the canvas is showing the project itself.
  const head = el("div", "insp-head");
  head.append(el("h2", undefined, snapshot.name), el("div", "insp-id", snapshot.dir));
  panel.append(head);
  panel.append(el("p", "responsibility", snapshot.goal));

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
    el("p", "bench-note", "Systems in a project are separate programs. They are shown together but never connected, which is why each can be written in its own language."),
  );
}
