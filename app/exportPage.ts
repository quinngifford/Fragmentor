import { createHash } from "node:crypto";
import { ROLE_IDS } from "../src/model/roles.js";
import type { Address, TraceEvent } from "../src/model/trace.js";
import type { PortType } from "../src/model/types.js";
import type { ProjectSnapshot, SnapshotBlock, SnapshotExecution } from "../src/project/snapshot.js";
import {
  accessFields,
  addressFields,
  blockFields,
  blockFilesFields,
  capabilityFields,
  codeFields,
  effectFields,
  executionFields,
  exposedFields,
  exposedPartFields,
  granularityFields,
  interactionFields,
  portFields,
  blockFunctionsFields,
  namedFunctionFields,
  projectFields,
  reachSeenFields,
  returnFields,
  routeStepFields,
  systemFields,
  traceFields,
  triggerFields,
} from "../src/project/snapshotFields.js";
import type { FieldUse } from "../src/project/snapshotFields.js";
import type { ExportLook } from "./renderer/state.js";

/**
 * A project as one read-only page anyone can open in a browser.
 *
 * The page is the window's own markup and styles, with the project's data
 * and a bundled script that draws it, all inline, so it opens from a file
 * with nothing installed and asks nothing of any network. It is a document,
 * not the application: nothing in it runs, edits or keeps anything.
 *
 * What leaves the person's computer is decided field by field, in the tables
 * snapshotFields.ts types over the snapshot, so a field added later does not
 * compile until someone decides whether it may. Then every string has the
 * project's folder and the home folder taken out, and the finished page is
 * searched for either, in every way a path can be written, before anything is
 * handed back. A page that would carry one is refused rather than repaired.
 */

/** What the page's script is handed. */
export interface ExportData {
  snapshot: ProjectSnapshot;
  look: ExportLook;
  /** The day it was exported, as YYYY-MM-DD. */
  exported: string;
  /** How many problems the project had, counted as the window's status bar counts them. Their messages stay home. */
  problems: { errors: number; warnings: number };
}

/* -------------------------------------------------------------------------- */
/* Copying a snapshot, field by field                                         */
/* -------------------------------------------------------------------------- */

type Uses<T> = { [K in keyof T]-?: { readonly export: FieldUse["export"] } };
type DroppedKeys<Table> = { [K in keyof Table]: Table[K] extends { export: "dropped" } ? K : never }[keyof Table];
type Plain = string | number | boolean | null | undefined;

/**
 * How one value is copied: what takes the place of each field that stays
 * home, and how to copy each kept field that is more than text or a number.
 * Both are required by type, so nothing is ever copied without being looked at.
 */
interface Spec<T, Table> {
  dropped: { [K in DroppedKeys<Table> & keyof T]-?: T[K] };
  nested: {
    [K in Exclude<keyof T, DroppedKeys<Table>> as T[K] extends Plain | readonly Plain[] ? never : K]-?: (
      value: Exclude<T[K], null | undefined>,
    ) => T[K];
  };
}

/** A copy of `value` holding exactly the fields its table lists: kept ones copied, dropped ones replaced. */
function copy<T extends object, Table extends Uses<T>>(value: T, table: Table, spec: Spec<T, Table>): T {
  const out: Record<string, unknown> = {};
  const replacements = spec.dropped as Record<string, unknown>;
  const copiers = spec.nested as Record<string, ((field: unknown) => unknown) | undefined>;
  for (const [key, use] of Object.entries(table as Record<string, { export: string }>)) {
    if (use.export === "dropped") {
      if (replacements[key] !== undefined) out[key] = replacements[key];
      continue;
    }
    if (!Object.hasOwn(value, key)) continue;
    const field = (value as Record<string, unknown>)[key];
    const copier = copiers[key];
    out[key] = field === null || field === undefined || copier === undefined ? field : copier(field);
  }
  return out as T;
}

/** A value an agent wrote down, such as what a step carried: taken as it is, and searched for folders like everything else. */
const data = (value: unknown): unknown => structuredClone(value);

const address = (value: Address): Address => copy(value, addressFields, { dropped: {}, nested: {} });

/** Where a step's code is, written as a block's code is, which may lead out of the project. */
type Pointer = (text: string) => string;
const withCode = <T extends { code?: string }>(value: T, pointer: Pointer): T =>
  value.code === undefined ? value : { ...value, code: pointer(value.code) };

function event(value: TraceEvent, pointer: Pointer): TraceEvent {
  switch (value.type) {
    case "interaction":
      return withCode(copy(value, interactionFields, { dropped: {}, nested: { from: address, to: address, payload: data } }), pointer);
    case "return":
      return copy(value, returnFields, { dropped: {}, nested: { from: address, to: address, response: data } });
    case "effect":
      return withCode(copy(value, effectFields, { dropped: {}, nested: { at: address, detail: data } }), pointer);
  }
}

/** What a dropped port type is replaced by: the type as written stays, and nothing on the page walks the structure. */
const UNKNOWN: PortType = { kind: "unknown" };

function block(value: SnapshotBlock, pointer: Pointer): SnapshotBlock {
  return copy(value, blockFields, {
    dropped: { stores: [], sources: { code: null, contract: null }, cases: [], reachNotChecked: [] },
    nested: {
      inputs: (ports) => ports.map((port) => copy(port, portFields, { dropped: { typeIr: UNKNOWN }, nested: {} })),
      outputs: (ports) => ports.map((port) => copy(port, portFields, { dropped: { typeIr: UNKNOWN }, nested: {} })),
      exposes: (entries) =>
        entries.map((entry) =>
          copy(entry, exposedFields, {
            dropped: {},
            nested: {
              route: (steps) => steps.map((step) => copy(step, routeStepFields, { dropped: {}, nested: {} })),
              fields: (parts) => parts.map((part) => copy(part, exposedPartFields, { dropped: {}, nested: {} })),
            },
          }),
        ),
      access: (all) => all.map((each) => copy(each, accessFields, { dropped: {}, nested: {} })),
      capabilities: (all) => all.map((each) => copy(each, capabilityFields, { dropped: {}, nested: {} })),
      files: (files) => {
        const copied = copy(files, blockFilesFields, { dropped: {}, nested: {} });
        return { ...copied, code: pointer(copied.code), contract: pointer(copied.contract) };
      },
      code: (code) => {
        const copied = copy(code, codeFields, { dropped: { excerpt: null, hash: null }, nested: {} });
        return { ...copied, pointer: pointer(copied.pointer), file: pointer(copied.file) };
      },
    },
  });
}

function execution(value: SnapshotExecution, pointer: Pointer): SnapshotExecution {
  return copy(value, executionFields, {
    dropped: { given: {}, expect: null, records: null, unrecordable: null },
    nested: {
      trigger: (trigger) => withCode(copy(trigger, triggerFields, { dropped: {}, nested: { payload: data } }), pointer),
      declared: (trace) =>
        copy(trace, traceFields, {
          dropped: { state: undefined },
          nested: { events: (events) => events.map((each) => event(each, pointer)) },
        }),
    },
  });
}

function project(value: ProjectSnapshot, pointer: Pointer): ProjectSnapshot {
  return copy(value, projectFields, {
    dropped: { dir: "", notes: [], rules: [], diagnostics: [], reachUnpointed: [] },
    nested: {
      granularity: (granularity) => copy(granularity, granularityFields, { dropped: {}, nested: {} }),
      systems: (systems) => systems.map((system) => copy(system, systemFields, { dropped: {}, nested: {} })),
      blocks: (blocks) => Object.fromEntries(Object.entries(blocks).map(([path, each]) => [path, block(each, pointer)])),
      executions: (executions) => executions.map((each) => execution(each, pointer)),
      reachSeen: (all) => all.map((each) => copy(each, reachSeenFields, { dropped: {}, nested: {} })),
      functions: (all) =>
        Object.fromEntries(
          Object.entries(all).map(([owner, credited]) => [
            owner,
            copy(credited, blockFunctionsFields, { dropped: {}, nested: { named: (list) => list.map((each) => copy(each, namedFunctionFields, { dropped: {}, nested: {} })) } }),
          ]),
        ),
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Folders                                                                     */
/* -------------------------------------------------------------------------- */

/** A separator in any spelling of a path: either slash, a backslash as JSON writes it, or percent-encoded. */
const SEP = "(?:[\\\\/]|%2[fF]|%5[cC])+";
/** How a path can name its drive before its first folder: `C:`, `/c` as Git Bash writes it, `/mnt/c` as WSL does. */
const DRIVE = `(?:[A-Za-z]:|${SEP}mnt${SEP}[A-Za-z]|${SEP}[A-Za-z](?=${SEP}))`;
/** The start of a file URL, which may come before any of them. */
const FILE_URL = `(?:file:(?:${SEP})?)?`;
/** The end of a folder's last name: anything but more of a name, so `tickets` is not found inside `tickets-old`. */
const END = "(?![\\p{L}\\p{N}_\\-])";
/** The start of a path: nothing of a name just before, so `/api` is never found inside `src/api`. */
const START = "(?<![\\p{L}\\p{N}_\\-])";

/**
 * A folder as a pattern matching it however a path writes it, starting where
 * a path starts: its drive in any spelling, or none, then its names, with
 * either kind of slash, a slash written twice as JSON writes a backslash,
 * spaces as `%20`, and in any case, as Windows reads paths.
 *
 * A folder of one name has to be found with its drive, since one name alone,
 * such as `api`, is part of countless paths that are not it; one with no drive
 * at all, such as `/srv`, names nobody and is not looked for. Null for those,
 * and for a folder with no name in it, such as a drive's root.
 */
function folderPattern(folder: string): { pattern: string; depth: number } | null {
  const names = folder.split(/[\\/]+/).filter((part) => part !== "" && !/^[A-Za-z]:$/.test(part));
  const drive = /^[A-Za-z]:/.test(folder);
  if (names.length === 0 || (names.length === 1 && !drive)) return null;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "(?: |%20)"));
  const drivePart = names.length === 1 ? DRIVE : `${DRIVE}?`;
  return { pattern: `${START}${FILE_URL}${drivePart}${SEP}${escaped.join(SEP)}${END}`, depth: names.length };
}

/**
 * Takes the project's folder, and the separator after it, out of a string,
 * and writes the home folder as `~`. The deeper folder goes first, so one
 * inside the other is never cut short before its own pattern can find it.
 */
function scrubber(projectDir: string, home: string): (text: string) => string {
  const replacements: { depth: number; pattern: RegExp; by: string }[] = [];
  const own = folderPattern(projectDir);
  if (own !== null) replacements.push({ depth: own.depth, pattern: new RegExp(`${own.pattern}(?:${SEP})?`, "giu"), by: "" });
  const theirs = folderPattern(home);
  if (theirs !== null) replacements.push({ depth: theirs.depth, pattern: new RegExp(theirs.pattern, "giu"), by: "~" });
  replacements.sort((a, b) => b.depth - a.depth);
  return (text) => replacements.reduce((each, { pattern, by }) => each.replace(pattern, by), text);
}

/**
 * A code pointer as the page may carry it. One that still leads out of the
 * project once the project's folder is taken out names a folder of this
 * computer, so only its file is kept.
 */
function pointerFor(scrub: (text: string) => string): (text: string) => string {
  return (text) => {
    const scrubbedText = scrub(text);
    if (!/^(?:[A-Za-z]:|[\\/]|~)/.test(scrubbedText)) return scrubbedText;
    return `…/${scrubbedText.split(/[\\/]/).at(-1) ?? ""}`;
  };
}

/** A copy with every string in it scrubbed, keys included. */
function scrubbed<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === "string") return scrub(value) as T;
  if (Array.isArray(value)) return value.map((each) => scrubbed(each, scrub)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [scrub(key), scrubbed(each, scrub)])) as T;
  }
  return value;
}

export class ExportLeakError extends Error {
  constructor(which: string) {
    super(`The page would carry ${which}, so it was not written. Nothing has been saved.`);
    this.name = "ExportLeakError";
  }
}

/* -------------------------------------------------------------------------- */
/* What the page holds                                                         */
/* -------------------------------------------------------------------------- */

/** The project as the page carries it: only the fields that may leave, with no folder of the computer in them. */
export function exportData(snapshot: ProjectSnapshot, look: ExportLook, options: { date: string; home: string }): ExportData {
  const errors = snapshot.diagnostics.filter((each) => each.severity === "error").length;
  const scrub = scrubber(snapshot.dir, options.home);
  return {
    snapshot: scrubbed(project(snapshot, pointerFor(scrub)), scrub),
    look: scrubbed(look, scrub),
    exported: options.date,
    problems: { errors, warnings: snapshot.diagnostics.length - errors },
  };
}

const COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * The look the window sent, as far as it is sound: colours that are colours,
 * blocks and an execution this project has. The window is not trusted to send
 * one, any more than with anything else it asks for.
 */
export function checkLook(raw: unknown, snapshot: ProjectSnapshot): ExportLook {
  const look = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const record = (value: unknown) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
  const colours = (value: unknown, known: (key: string) => boolean) =>
    Object.fromEntries(
      Object.entries(record(value)).filter(([key, colour]) => known(key) && typeof colour === "string" && COLOUR.test(colour)),
    ) as Record<string, string>;

  const roles = new Set<string>(ROLE_IDS);
  const isBlock = (path: string) => Object.hasOwn(snapshot.blocks, path);
  const picked = record(look.execution);
  const execution = snapshot.executions.find((each) => each.id === picked.id && each.declared !== null);
  const steps = execution?.declared?.events.length ?? 0;

  return {
    colourBy: look.colourBy === "role" ? "role" : "block",
    roleColours: colours(look.roleColours, (role) => roles.has(role)),
    blockColours: colours(look.blockColours, isBlock),
    showDependencies: look.showDependencies === true,
    legendCollapsed: look.legendCollapsed === true,
    folded: [...new Set(Array.isArray(look.folded) ? look.folded.filter((path): path is string => typeof path === "string" && isBlock(path)) : [])],
    execution:
      execution === undefined
        ? null
        : { id: execution.id, at: Number.isInteger(picked.at) && (picked.at as number) >= 0 && (picked.at as number) < steps ? (picked.at as number) : 0 },
  };
}

/** A file name the person's disk will take, from a project name that may hold anything. */
export function saveName(name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/^[\s.]+|[\s.]+$/g, "");
  return safe === "" ? "project" : safe;
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

export class ExportPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportPageError";
  }
}

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Replaces one exact piece of the window's markup, which has to be there exactly once. */
function swap(page: string, needle: string, by: string): string {
  const parts = page.split(needle);
  if (parts.length !== 2) {
    throw new ExportPageError(`The window's markup has ${parts.length - 1} of "${needle.slice(0, 60)}" where the export needs exactly one.`);
  }
  // Joined rather than replaced, so a `$&` in a project's text stays as written.
  return parts.join(by);
}

/**
 * The page: the window's own markup and styles, the data as a JSON element
 * the script parses, and the script, all inline, under a policy that lets in
 * nothing but those two by their hashes.
 *
 * `forbidden` is every folder that must not appear in it — the project's and
 * the home folder — searched for in every way a path can be written.
 */
export function exportPage(assets: { index: string; css: string; script: string }, data: ExportData, forbidden: string[]): string {
  const index = assets.index.replace(/\r\n/g, "\n");
  const css = assets.css.replace(/\r\n/g, "\n");
  const { script } = assets;
  if (/<\/script/i.test(script) || script.includes("<!--")) {
    throw new ExportPageError("The page's script holds something that would end its own element early, so no page was made.");
  }
  if (/<\/style/i.test(css)) throw new ExportPageError("The styles hold something that would end their own element early, so no page was made.");

  // Every `<` written as an escape, so nothing in what the agent wrote can
  // close the element it sits in or start a comment.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  let page = index;
  page = swap(
    page,
    `content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:;"`,
    `content="default-src 'none'; script-src ${sha256(script)}; style-src ${sha256(css)}; img-src data:; base-uri 'none'; form-action 'none'"`,
  );
  page = swap(page, "<title>Fragmentor</title>", `<title>${escapeHtml(data.snapshot.name)}</title>`);
  page = swap(page, `<link rel="stylesheet" href="./styles.css" />`, `<style>${css}</style>`);
  page = swap(page, "<body>", `<body data-export data-project="open">`);
  page = swap(
    page,
    `<script type="module" src="./app.js"></script>`,
    [
      `<script type="application/json" id="fragmentor-export">${json}</script>`,
      `<noscript><p class="bench-note">This page needs JavaScript turned on to draw the project.</p></noscript>`,
      `<script>${script}</script>`,
    ].join("\n    "),
  );

  for (const folder of forbidden) {
    const pattern = folderPattern(folder);
    if (pattern !== null && new RegExp(pattern.pattern, "iu").test(page)) throw new ExportLeakError(`the folder ${folder}`);
  }
  return page;
}
