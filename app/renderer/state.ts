import type { ProjectSnapshot } from "../../src/project/snapshot.js";
import type { CaseResult, RunEvent, RunOutcome } from "../../src/run/run.js";
import type { Role } from "../../src/model/roles.js";

/**
 * What the interface is currently showing. Kernel types are imported for their
 * shapes only — no kernel code runs in the renderer, which has no filesystem.
 */

/** One block call in a watched run, as far as the playback has shown it. */
export interface WatchedCall {
  id: number;
  parent: number | null;
  block: string;
  input: unknown;
  output?: unknown;
  error?: string;
  /** "stopped" is a call the run ended before it could finish. */
  state: "running" | "paused" | "returned" | "threw" | "stopped";
}

/**
 * A run shown on the canvas. It is played back at a pace a person can follow,
 * so what is on screen can be behind what has happened; everything shown is
 * derived from the events played so far.
 */
export interface Watch {
  runId: string;
  /** The block that was run. */
  blockPath: string;
  events: RunEvent[];
  /** How many of the events have been shown. */
  played: number;
  /** Every call, as of the events shown so far. */
  calls: Map<number, WatchedCall>;
  /** The call Continue and Step act on, when the run is held. Others may be waiting behind it. */
  heldId: number | null;
  /** Set when the run has ended. */
  outcome: RunOutcome | null;
  /** Which call of a block to show inside its diagram when it ran more than once, by block path. */
  frames: Map<string, number>;
}

export interface UiState {
  snapshot: ProjectSnapshot | null;
  /** The folder open as a project, even while it holds nothing readable. */
  dir: string | null;
  /** True while the agent has not defined a system yet. */
  waiting: boolean;
  /** Why the newest version of the project could not be read. The last good snapshot stays on screen. */
  loadError: string | null;
  /** The composite whose diagram is on the canvas. */
  view: string;
  /** Node keys inside the current diagram: a child id, or `input` / `output`. */
  selection: Set<string>;
  /**
   * The connection picked out on the diagram: a bus carrying values between
   * two blocks, or an access reaching a database or a queue. The two kinds
   * cannot share an id, so one field holds whichever is selected.
   */
  selectedLink: string | null;
  zoom: number;
  panX: number;
  panY: number;
  showRail: boolean;
  showInspector: boolean;
  /** Whether the legend is folded away to its heading. */
  legendCollapsed: boolean;
  setLegendCollapsed(value: boolean): void;
  /** How wide the inspector is, in pixels. Dragged by hand and kept between sessions. */
  inspectorWidth: number;
  codeTab: "impl" | "contract";
  /** Once the view has been moved by hand, stop refitting it automatically. */
  userAdjusted: boolean;
  /**
   * Unsaved edits to a block's implementation, keyed by block path, with the
   * file as it was when editing began. That is how a change made on disk in
   * the meantime — usually by the agent — is pointed out rather than silently
   * overwritten.
   */
  edits: Map<string, { base: string | null; text: string }>;
  /** What has been typed into each block's test bench, kept across redraws. */
  benchInputs: Map<string, Record<string, unknown>>;
  /** The last result from running each block. */
  runs: Map<string, RunOutcome>;
  /** Blocks currently running. */
  running: Set<string>;
  /** The last result of running each block's saved tests. */
  caseResults: Map<string, CaseResult[]>;
  /** Blocks whose saved tests are running. */
  runningCases: Set<string>;
  /** The name being typed for a new test, per block. */
  caseNames: Map<string, string>;
  /** Blocks a watched run pauses before, by path. */
  breakpoints: Set<string>;
  /** The run on the canvas, if there is one. */
  watch: Watch | null;
  status: { text: string; tone: "info" | "good" | "bad" } | null;
}

const WIDTH_KEY = "fragmentor.inspectorWidth";

/** How wide the inspector may be dragged. Narrow enough to read, wide enough for code. */
export const INSPECTOR_WIDTH = { least: 280, most: 900, standard: 360 };

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (!Number.isFinite(stored) || stored <= 0) return INSPECTOR_WIDTH.standard;
    return Math.min(INSPECTOR_WIDTH.most, Math.max(INSPECTOR_WIDTH.least, stored));
  } catch {
    return INSPECTOR_WIDTH.standard;
  }
}

/** Kept in this browser profile, like the bus colours: it is how someone likes to look at a project, not part of it. */
export function rememberInspectorWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable; the width simply starts from the default next time.
  }
}

export const ui: UiState = {
  snapshot: null,
  dir: null,
  waiting: false,
  loadError: null,
  view: "",
  selection: new Set(),
  selectedLink: null,
  zoom: 1,
  panX: 40,
  panY: 30,
  showRail: true,
  showInspector: true,
  // Folded away or not is a preference like the others, and outlives a
  // project, so it is remembered here rather than reset on every open.
  legendCollapsed: (() => {
    try {
      return localStorage.getItem("fragmentor.legendCollapsed") === "true";
    } catch {
      return false;
    }
  })(),
  setLegendCollapsed(value: boolean): void {
    this.legendCollapsed = value;
    try {
      localStorage.setItem("fragmentor.legendCollapsed", String(value));
    } catch {
      // Remembering is a nicety; folding it away still works.
    }
  },
  inspectorWidth: readWidth(),
  codeTab: "impl",
  userAdjusted: false,
  edits: new Map(),
  benchInputs: new Map(),
  runs: new Map(),
  running: new Set(),
  caseResults: new Map(),
  runningCases: new Set(),
  caseNames: new Map(),
  breakpoints: new Set(),
  watch: null,
  status: null,
};

export function requireSnapshot(): ProjectSnapshot {
  if (!ui.snapshot) throw new Error("No project is open.");
  return ui.snapshot;
}

export function blockAt(path: string) {
  return requireSnapshot().blocks[path];
}

export function currentBlock() {
  return blockAt(ui.view);
}

/* -------------------------------------------------------------------------- */
/* How the diagram is drawn                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a colour on the diagram means.
 *
 * `role` says what kind of thing something is: green for code inside the
 * program, and a hue apiece for the databases, queues, services and people
 * around it. `block` gives every block a colour of its own and paints what
 * leaves it to match, which is easier to follow along one wire and says
 * nothing about what anything is.
 */
export type ColourBy = "role" | "block";

/** A viewing preference rather than part of the design, so it stays in this profile. */
function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeChoice(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A profile that will not store anything still draws; it just forgets.
  }
}

export const COLOUR_BY: readonly ColourBy[] = ["block", "role"];

export const viewSettings = {
  colourBy: readChoice("fragmentor.colourBy", COLOUR_BY, "block"),
  setColourBy(value: ColourBy): void {
    this.colourBy = value;
    writeChoice("fragmentor.colourBy", value);
  },
};

/** Colours a bus can be given. Restrained enough to stay an instrument panel. */
/**
 * The colours a bus can take, which are all greens.
 *
 * Hue means one thing on this canvas: green is data moving inside the
 * program, and anything else belongs to the world outside it. So buses, which
 * are always the first of those, are told apart by shade rather than by
 * borrowing a hue that now says "database" or "someone else's service". A bus
 * can still be given any colour by hand.
 */
export const BUS_PALETTE = ["#4fe38f", "#8fe34f", "#3fcf9e", "#b5e06a", "#5fd8c0", "#2fb87a"];

const COLORS_KEY = "fragmentor.busColors";

function writeStore(key: string, value: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable; a choice simply falls back to the default.
  }
}

function readStore(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

/**
 * Bus colours are a viewing preference rather than part of the design, so they
 * stay in this browser profile. Block positions are not: those live in the
 * project, because how a diagram is arranged is part of how it reads.
 */
export const busColors = {
  all: readStore(COLORS_KEY),
  key(view: string, busId: string): string {
    return `${ui.snapshot?.dir ?? ""}|${view}|${busId}`;
  },
  get(view: string, busId: string): string | undefined {
    return this.all[this.key(view, busId)];
  },
  set(view: string, busId: string, colour: string | null): void {
    const key = this.key(view, busId);
    const next = { ...this.all };
    if (colour === null) delete next[key];
    else next[key] = colour;
    this.all = next;
    writeStore(COLORS_KEY, next);
  },
};

/**
 * What each kind of block is drawn in.
 *
 * Ordered as a wheel from what is most yours to what is least — code, the
 * data it holds, the data it keeps, the programs it owns, the people it
 * serves, the services it does not control — so the hues run in the same
 * direction the meaning does. Green stays the signal colour it always was.
 *
 * These are the defaults. A person can change any of them from the legend,
 * and their choice is theirs rather than the project's, so it stays in this
 * browser profile.
 */
export const DEFAULT_ROLE_COLOURS: Record<Role, string> = {
  function: "#37dc89",   // bright mint green
  structure: "#67D8FF",  // bright cyan
  queue: "#FFD166",      // warm yellow
  storage: "#5EEAD4",    // aqua/teal
  database: "#7C9CFF",   // periwinkle blue
  service: "#C084FC",    // bright purple
  client: "#FFB86B",     // soft bright orange
  external: "#F472B6",   // pink, distinct without reading as error
};

/**
 * Colours used when blocks are coloured individually instead of by role.
 * Ordered so neighbouring colours stay visually distinct.
 */
export const BLOCK_PALETTE = [
  "#37dc89", // mint
  "#C084FC", // purple
  "#FFD166", // yellow
  "#67D8FF", // cyan
  "#FF8FA3", // coral pink
  "#7C9CFF", // periwinkle
  "#FFB86B", // orange
  "#5EEAD4", // aqua
];

const ROLE_COLOURS_KEY = "fragmentor.roleColours";
const BLOCK_COLOURS_KEY = "fragmentor.blockColours";

/** What each kind is drawn in, as changed from the legend. */
export const roleColours = {
  all: readStore(ROLE_COLOURS_KEY) as Partial<Record<Role, string>>,
  get(role: Role): string {
    return this.all[role] ?? DEFAULT_ROLE_COLOURS[role];
  },
  set(role: Role, colour: string | null): void {
    const next = { ...this.all };
    if (colour === null) delete next[role];
    else next[role] = colour;
    this.all = next;
    writeStore(ROLE_COLOURS_KEY, next as Record<string, string>);
    this.apply();
  },
  /**
   * Put on the document itself, so every block, line, badge and swatch of
   * that kind follows from one place rather than each working it out.
   */
  apply(): void {
    for (const role of Object.keys(DEFAULT_ROLE_COLOURS) as Role[]) {
      document.documentElement.style.setProperty(`--role-${role}`, this.get(role));
    }
  },
};

/** What one block is drawn in, when the diagram is coloured block by block. */
export const blockColours = {
  all: readStore(BLOCK_COLOURS_KEY),
  key(view: string, blockKey: string): string {
    return `${ui.snapshot?.dir ?? ""}|${view}|${blockKey}`;
  },
  get(view: string, blockKey: string): string | undefined {
    return this.all[this.key(view, blockKey)];
  },
  set(view: string, blockKey: string, colour: string | null): void {
    const key = this.key(view, blockKey);
    const next = { ...this.all };
    if (colour === null) delete next[key];
    else next[key] = colour;
    this.all = next;
    writeStore(BLOCK_COLOURS_KEY, next);
  },
};
