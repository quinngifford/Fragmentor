import type { PortType } from "../../src/model/types.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { BUS_PALETTE, busColors, requireSnapshot, ui } from "./state.js";
import { busColour, connectionCode } from "./graph.js";
import type { Bus, Graph } from "./graph.js";
import { graphInView, openDiagram } from "./canvas.js";

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

function section(title: string): HTMLElement {
  const node = el("section", "section");
  node.append(el("h3", undefined, title));
  return node;
}

/* -------------------------------------------------------------------------- */
/* Test bench                                                                  */
/* -------------------------------------------------------------------------- */

function exampleFor(type: PortType, name?: string): unknown {
  switch (type.kind) {
    case "string":
      return name && /path/i.test(name) ? "./postings.json" : "example";
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
      return [exampleFor(type.of, name)];
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

function field(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = el("div", "field");
  wrap.append(el("label", undefined, labelText), control);
  return wrap;
}

function controlFor(type: PortType, name: string): HTMLElement {
  if (type.kind === "object") {
    const group = el("div", "subfields");
    for (const [fieldName, spec] of Object.entries(type.fields)) {
      group.append(controlFor(spec.type, fieldName + (spec.optional ? "?" : "")));
    }
    return field(name, group);
  }

  if (type.kind === "array") {
    const area = el("textarea");
    area.value = JSON.stringify(exampleFor(type, name), null, 1);
    area.spellcheck = false;
    return field(name, area);
  }

  if (type.kind === "boolean") {
    const box = el("input");
    box.type = "checkbox";
    return field(name, box);
  }

  if (type.kind === "enum") {
    const select = el("select");
    for (const value of type.values) {
      const option = el("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    return field(name, select);
  }

  const input = el("input");
  input.type = type.kind === "number" ? "number" : "text";
  const sample = exampleFor(type, name);
  input.value = sample === null ? "" : String(sample);
  return field(name, input);
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                      */
/* -------------------------------------------------------------------------- */

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
  const node = section("Code");

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

  const onDisk = block.sources[ui.codeTab];
  const isContract = ui.codeTab === "contract";
  const pending = ui.edits.get(block.path);
  const value = isContract ? onDisk : (pending ?? onDisk);

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

  editor.addEventListener("input", () => {
    if (editor.value === onDisk) ui.edits.delete(block.path);
    else ui.edits.set(block.path, editor.value);
    save.disabled = editor.value === onDisk;
    dirty.textContent = editor.value === onDisk ? "Saved." : "Unsaved changes.";
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

  const dirty = el("p", "bench-note", value === onDisk ? "Saved." : "Unsaved changes.");
  foot.append(save, revert, reveal, dirty);
  node.append(foot);
  return node;
}

function benchSection(block: SnapshotBlock): HTMLElement {
  const node = section("Test bench");
  node.append(el("p", "bench-note", "Built from the port types above. The values are examples, and no block can run yet."));
  for (const port of block.inputs) node.append(controlFor(port.typeIr, port.name));

  const run = el("button", "btn", "Run block");
  run.disabled = true;
  run.title = "Running a block is not built yet.";
  node.append(run);
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
  panel.append(portSection("Inputs", block.inputs));
  panel.append(portSection("Outputs", block.outputs));
  panel.append(portSection("Capabilities", block.capabilities, true));
  panel.append(codeSection(block));
  panel.append(benchSection(block));
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
  code.append(el("p", "bench-note", "The call and binding this connection becomes. Composite glue is not written yet, so this is derived from the diagram rather than read from the file."));
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
    panel.append(el("p", "bench-note", "Open a project to inspect its blocks."));
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
