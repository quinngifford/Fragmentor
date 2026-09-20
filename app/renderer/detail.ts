import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { ROLES } from "../../src/model/roles.js";
import { revealBlock } from "./canvas.js";
import { el, section } from "./dom.js";

/**
 * What a block holds, written out: its contract, the tables or operations it
 * offers, and what it reaches.
 *
 * The same sections are read in two places — down the inspector, and in the
 * window a block opens — so they are written once here.
 */

export function portSection(
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

/**
 * A code box that can be typed in and is still coloured. The coloured copy is
 * drawn underneath, and the box itself is transparent apart from its caret, so
 * there is only ever one piece of text to keep in step — what was typed.
 */

export function exposedSection(block: SnapshotBlock): HTMLElement {
  const noun = ROLES[block.role].entryNoun;
  const node = section(`${noun.charAt(0).toUpperCase()}${noun.slice(1)}s`);

  if (block.exposes.length === 0) {
    node.append(el("p", "bench-note", `Nothing is written down yet. The agent lists each ${noun} under "exposes".`));
    return node;
  }

  const list = el("div", "ports");
  for (const entry of block.exposes) {
    // A store holds one shape, so saying it twice would read as two things.
    const oneShape = entry.accepts !== null && entry.accepts === entry.returns;
    const shape = oneShape
      ? entry.accepts!
      : [entry.accepts === null ? null : `in ${entry.accepts}`, entry.returns === null ? null : `out ${entry.returns}`]
          .filter(Boolean)
          .join("    ");

    const row = el("div", "port-row");
    row.append(el("div", "pname", entry.name), el("div", "ptype", shape));
    if (entry.description) row.append(el("div", "pdesc", entry.description));
    list.append(row);
  }
  node.append(list);
  return node;
}


/** What this block reaches, with each resource named as it was found. */
export function accessSection(block: SnapshotBlock): HTMLElement | null {
  if (block.access.length === 0) return null;

  const node = section("Reaches");
  const list = el("div", "ports");

  for (const access of block.access) {
    const row = el("div", "port-row cap");
    row.append(el("div", "pname", access.verb));

    if (access.resourcePath === null) {
      const missing = el("div", "ptype bad");
      missing.textContent = `${access.resource} — nothing of that name is among its parts, beside it, or above it`;
      row.append(missing);
    } else {
      const where = access.entry === null ? access.resourceName : `${access.resourceName} · ${access.entry}`;
      row.append(el("div", "ptype", where));
      const open = el("button", "btn quiet tiny", "Show");
      open.addEventListener("click", () => revealBlock(access.resourcePath!));
      row.append(open);
    }

    list.append(row);
  }

  node.append(list);
  return node;
}
