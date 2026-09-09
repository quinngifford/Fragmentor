import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";

/**
 * Where the blocks sit on the canvas.
 *
 * This lives in the project rather than in the viewer's browser, because how a
 * diagram is arranged is part of how readable it is, and two people looking at
 * the same project should see the same picture. It is kept in its own file so
 * that moving a block never rewrites a block.json and makes the diagram look
 * changed when it is not.
 */

export interface Point {
  x: number;
  y: number;
}

/** view path -> node key -> position. Node keys are child ids, or `input` / `output`. */
export type Layout = Record<string, Record<string, Point>>;

const pointSchema = z.object({ x: z.number(), y: z.number() }).strict();
export const layoutSchema = z.record(z.string(), z.record(z.string(), pointSchema));

const LAYOUT_FILE = "layout.json";

export function layoutPath(projectDir: string): string {
  return path.join(projectDir, LAYOUT_FILE);
}

export async function loadLayout(projectDir: string): Promise<Layout> {
  try {
    const raw = JSON.parse(await readFile(layoutPath(projectDir), "utf8"));
    const parsed = layoutSchema.safeParse(raw);
    // A layout that cannot be read is not worth failing over; the canvas can
    // always fall back to arranging the blocks itself.
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function saveLayout(projectDir: string, layout: Layout): Promise<void> {
  const rounded: Layout = {};
  for (const [view, nodes] of Object.entries(layout)) {
    rounded[view] = {};
    for (const [key, point] of Object.entries(nodes)) {
      rounded[view][key] = { x: Math.round(point.x), y: Math.round(point.y) };
    }
  }
  await writeFile(layoutPath(projectDir), `${JSON.stringify(rounded, null, 2)}\n`, "utf8");
}

/** Replaces the positions for one diagram, leaving every other diagram alone. */
export async function saveViewLayout(
  projectDir: string,
  viewPath: string,
  positions: Record<string, Point>,
): Promise<void> {
  const current = await loadLayout(projectDir);
  await saveLayout(projectDir, { ...current, [viewPath]: positions });
}
