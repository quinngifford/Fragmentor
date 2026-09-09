import type { ProjectSnapshot } from "../../src/project/snapshot.js";

/**
 * What the interface is currently showing. Kernel types are imported for their
 * shapes only — no kernel code runs in the renderer, which has no filesystem.
 */

export interface UiState {
  snapshot: ProjectSnapshot | null;
  /** The composite whose diagram is on the canvas. */
  view: string;
  /** Node keys inside the current diagram: a child id, or `input` / `output`. */
  selection: Set<string>;
  selectedBus: string | null;
  zoom: number;
  panX: number;
  panY: number;
  showRail: boolean;
  showInspector: boolean;
  codeTab: "impl" | "contract";
  /** Once the view has been moved by hand, stop refitting it automatically. */
  userAdjusted: boolean;
  /** Unsaved edits to a block's implementation, keyed by block path. */
  edits: Map<string, string>;
  status: { text: string; tone: "info" | "good" | "bad" } | null;
}

export const ui: UiState = {
  snapshot: null,
  view: "",
  selection: new Set(),
  selectedBus: null,
  zoom: 1,
  panX: 40,
  panY: 30,
  showRail: true,
  showInspector: true,
  codeTab: "impl",
  userAdjusted: false,
  edits: new Map(),
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

/** Colours a bus can be given. Restrained enough to stay an instrument panel. */
export const BUS_PALETTE = ["#4fe38f", "#4fc9e3", "#e2a54b", "#b98ce6", "#e3778c", "#8fe34f"];

const COLORS_KEY = "fragmentor.busColors";

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
    try {
      localStorage.setItem(COLORS_KEY, JSON.stringify(next));
    } catch {
      // Storage can be unavailable; colours simply fall back to the defaults.
    }
  },
};
