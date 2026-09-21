import type { SnapshotBlock } from "../../src/project/snapshot.js";
import { ROLES } from "../../src/model/roles.js";
import { revealBlock } from "./canvas.js";
import { el, section, subsection } from "./dom.js";
import { typeLine } from "./highlight.js";

/**
 * What a block holds, written out.
 *
 * Every block says the same two things in the same two places: its
 * **interface**, meaning whatever the rest of the system uses it through, and
 * what it **reaches**. A function's interface is the values it takes, gives
 * back and needs supplied; a database's is its tables, a queue's its channels,
 * a service's its operations. The heading is the same for all of them and the
 * part inside it carries the word for that kind of thing, so someone who has
 * read one block's panel can predict the next one's.
 *
 * The same sections are read in two places — down the inspector, and in the
 * window a block opens — so they are written once here.
 */

/** `in { … }` and `out { … }`, with the label quiet and the shape coloured. */
function shapeLine(label: string | null, shape: string): HTMLElement {
  const line = el("div", "pshape");
  if (label) line.append(el("span", "pshape-label", label));
  line.append(typeLine(shape, "ptype"));
  return line;
}

/**
 * The ports of one kind, under the word for that kind.
 *
 * `Inputs`, `Outputs` and `Capabilities` are three parts of one interface
 * rather than three sections of the panel, because a caller needs all three to
 * call the thing and none of them means anything without the others.
 */
function portGroup(
  title: string,
  ports: { name: string; type?: string; capability?: string; description: string | null }[],
  isCapability = false,
): HTMLElement {
  const node = subsection(title);
  if (ports.length === 0) {
    node.append(el("p", "bench-note", "None."));
    return node;
  }

  const list = el("div", "ports");
  for (const port of ports) {
    const line = el("div", `port-row${isCapability ? " cap" : ""}`);
    line.append(el("div", "pname", port.name));
    line.append(shapeLine(null, (isCapability ? port.capability : port.type) ?? ""));
    if (port.description) line.append(el("div", "pdesc", port.description));
    list.append(line);
  }
  node.append(list);
  return node;
}

/** Where one of a block's entries leads, when it leads anywhere. */
export interface EntryRoute {
  /** The entry this is about. */
  entry: string;
  /** `Booking API · bookSeats → Book Seats`, as far as it could be followed. */
  route: string;
  /** The block at the end of it, when the end is code. */
  endsAt: string | null;
}

/**
 * What an architecture block offers: its tables, channels, operations or
 * actions, each with its shape and, where it leads somewhere, the route it
 * sets going.
 *
 * The route belongs on the entry's own row rather than in a list of its own.
 * A section that repeated every entry's name to say where it led was the panel
 * saying the same thing twice, and "when this happens" never said what it was
 * a heading for.
 */
function exposedGroup(block: SnapshotBlock, routes: EntryRoute[] = []): HTMLElement {
  const noun = ROLES[block.role].entryNoun;
  const node = subsection(`${noun.charAt(0).toUpperCase()}${noun.slice(1)}s`);

  if (block.exposes.length === 0) {
    node.append(
      el(
        "p",
        "bench-note",
        block.role === "component"
          ? "None listed. A group of parts offers whatever the parts inside it do."
          : `No ${noun}s listed yet.`,
      ),
    );
    return node;
  }

  const list = el("div", "ports");
  for (const entry of block.exposes) {
    const line = el("div", "port-row");
    line.append(el("div", "pname", entry.name));

    // A store holds one shape, so saying it twice would read as two things.
    if (entry.accepts !== null && entry.accepts === entry.returns) {
      line.append(shapeLine(null, entry.accepts));
    } else {
      if (entry.accepts !== null) line.append(shapeLine("in", entry.accepts));
      if (entry.returns !== null) line.append(shapeLine("out", entry.returns));
    }

    if (entry.description) line.append(el("div", "pdesc", entry.description));

    const leads = routes.find((each) => each.entry === entry.name);
    if (leads) {
      const where = el("div", "proute");
      where.append(el("span", "proute-label", "runs"), el("span", "proute-text", leads.route));
      if (leads.endsAt !== null) {
        const open = el("button", "btn quiet tiny", "Go there");
        open.title = "Show the block where this is answered";
        open.addEventListener("click", () => revealBlock(leads.endsAt!));
        where.append(open);
      }
      line.append(where);
    }

    list.append(line);
  }

  node.append(list);
  return node;
}

/** What this block reaches, with each resource named as it was found. */
export function reachesSection(block: SnapshotBlock): HTMLElement | null {
  if (block.access.length === 0) return null;

  const node = section("Reaches");
  const list = el("div", "ports");

  for (const access of block.access) {
    const line = el("div", "port-row cap");
    line.append(el("div", "pname", access.verb));

    if (access.resourcePath === null) {
      const missing = el("div", "ptype bad");
      missing.textContent = `${access.resource} — nothing of that name is among its parts, beside it, or above it`;
      line.append(missing);
    } else {
      // The thing reached and the way to it on one line, because the button
      // is about that one resource and nothing else on the row.
      const where = el("div", "pwhere");
      where.append(el("span", "ptype", access.entry === null ? access.resourceName : `${access.resourceName} · ${access.entry}`));
      const open = el("button", "btn quiet tiny", "Show");
      open.addEventListener("click", () => revealBlock(access.resourcePath!));
      where.append(open);
      line.append(where);
    }

    list.append(line);
  }

  node.append(list);
  return node;
}

/**
 * The one section that says what a block can be used through, whatever kind of
 * thing it is. Every block panel has it, so it is the one heading a reader can
 * count on finding in the same place on every block.
 *
 * `routes` is only ever given for a block whose entries lead somewhere, which
 * is the inspector's business rather than the window's.
 */
export function interfaceSection(block: SnapshotBlock, routes: EntryRoute[] = []): HTMLElement {
  const node = section("Interface");

  if (!block.architecture) {
    node.append(portGroup("Inputs", block.inputs));
    node.append(portGroup("Outputs", block.outputs));
    if (block.capabilities.length > 0) node.append(portGroup("Capabilities", block.capabilities, true));
    return node;
  }

  node.append(exposedGroup(block, routes));
  return node;
}
