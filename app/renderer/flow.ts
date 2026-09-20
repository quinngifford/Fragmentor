import type { Trace, TraceEvent } from "../../src/model/trace.js";
import { BOX_H, BOX_W } from "./tree.js";

/**
 * One execution as a drawing of its own: step after step, left to right.
 *
 * The tree says what a system is; this says what one run did, and the two are
 * never the same picture. A block appears once for every time the run is at
 * it, so nothing ever loops back: a call out to the database and the answer
 * coming back are three boxes in a row — the caller, the database, and the
 * caller again — rather than two boxes with arrows curling between them.
 *
 * Where the run carries on somewhere else entirely, the block it carries on
 * from is drawn again, with no arrow into it, because nothing travelled.
 */

/** How far apart two boxes in a row stand: room for the arrow between them and its word. */
const ARROW_W = 104;
/** Between one row and the next: room for what a step left behind, under the box. */
const ROW_GAP = 78;
/** Boxes to a row before it wraps. */
const PER_ROW = 5;

export interface FlowArrow {
  /** The step this arrow is, by its place in the trace. */
  at: number;
  label: string;
  /** Whether anything travelled along it. */
  data: boolean;
  /** An answer coming back to whoever asked. */
  back: boolean;
}

export interface FlowBox {
  /** The block the run is at, or null for outside the system. */
  path: string | null;
  x: number;
  y: number;
  /** How it got here. Null for the box the run starts from, and where it carries on elsewhere. */
  arrow: FlowArrow | null;
  /** What the run left while it was here. */
  effects: { at: number; label: string }[];
  /** True when the box before it is on the row above. */
  wrapped: boolean;
}

export interface Flow {
  boxes: FlowBox[];
  width: number;
  height: number;
}

const words = (kind: string) => kind.replace(/-/g, " ");

/** Which way a step runs on the drawing: an answer travels back to whoever asked. */
function ends(event: TraceEvent): { from: string | null; to: string | null } | null {
  if (event.type === "effect") return null;
  if (event.type === "return") return { from: event.to.path, to: event.from?.path ?? null };
  return { from: event.from?.path ?? null, to: event.to.path };
}

/**
 * Every step of a trace, in order, as boxes and the arrows between them.
 * `stepWord` says what to write on an arrow, so the flow and the tree call
 * the same step by the same name.
 */
export function buildFlow(trace: Trace, stepWord: (event: TraceEvent) => string): Flow {
  const boxes: FlowBox[] = [];
  const add = (path: string | null, arrow: FlowArrow | null) => {
    const box: FlowBox = { path, x: 0, y: 0, arrow, effects: [], wrapped: false };
    boxes.push(box);
    return box;
  };

  trace.events.forEach((event, at) => {
    if (event.type === "effect") {
      // Left where the run is, or where it is not: then the block it happened
      // at is drawn again to hold it.
      const here = boxes[boxes.length - 1];
      if (!here || here.path !== event.at.path) add(event.at.path, null);
      boxes[boxes.length - 1]!.effects.push({ at, label: words(event.kind) });
      return;
    }

    const step = ends(event);
    if (!step) return;
    const here = boxes[boxes.length - 1];
    if (!here || here.path !== step.from) add(step.from, null);
    add(step.to, {
      at,
      label: stepWord(event),
      data: (event.type === "interaction" && event.payload !== undefined) || (event.type === "return" && event.response !== undefined),
      back: event.type === "return",
    });
  });

  boxes.forEach((box, at) => {
    const column = at % PER_ROW;
    box.x = column * (BOX_W + ARROW_W);
    box.y = Math.floor(at / PER_ROW) * (BOX_H + ROW_GAP);
    box.wrapped = column === 0 && at > 0;
  });

  const rows = Math.ceil(boxes.length / PER_ROW);
  return {
    boxes,
    width: Math.min(boxes.length, PER_ROW) * (BOX_W + ARROW_W) - ARROW_W,
    height: Math.max(0, rows * (BOX_H + ROW_GAP) - ROW_GAP),
  };
}

/** The box a step is drawn as, so stepping through and the drawing agree on where it is. */
export function boxOfStep(flow: Flow, at: number): FlowBox | null {
  return (
    flow.boxes.find((box) => box.arrow?.at === at) ??
    flow.boxes.find((box) => box.effects.some((effect) => effect.at === at)) ??
    null
  );
}
