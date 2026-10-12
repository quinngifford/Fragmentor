import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addNote } from "../src/project/notes.js";
import { projectSnapshot } from "../src/project/snapshot.js";
import type { ProjectSnapshot } from "../src/project/snapshot.js";
import { ExportLeakError, ExportPageError, checkLook, exportData, exportPage, saveName } from "./exportPage.js";
import type { ExportData } from "./exportPage.js";
import type { ExportLook } from "./renderer/state.js";

/**
 * The exported page, built from real copies of both examples with the
 * window's own markup and styles. What is held to here is what a reader is
 * handed: nothing private, nothing that can run but its own script, and the
 * project exactly as the agent wrote it, hostile text included.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.join(here, "..", "examples");
const HOME = "C:\\Users\\Testperson";
const DATE = "2026-10-02";
const SCRIPT = "document.body.dataset.ready = 'true';";

let root: string;
let index: string;
let css: string;
let messenger: ProjectSnapshot;
let tickets: ProjectSnapshot;
let ticketsDir: string;

const look: ExportLook = {
  colourBy: "block",
  roleColours: {},
  blockColours: {},
  showDependencies: false,
  legendCollapsed: false,
  folded: [],
  execution: null,
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fragmentor-export-"));
  index = await readFile(path.join(here, "renderer", "index.html"), "utf8");
  css = await readFile(path.join(here, "renderer", "styles.css"), "utf8");
  const messengerDir = path.join(root, "messenger");
  ticketsDir = path.join(root, "tickets");
  await cp(path.join(examples, "messenger"), messengerDir, { recursive: true });
  await cp(path.join(examples, "tickets"), ticketsDir, { recursive: true });
  // A note, which a page must never carry.
  await addNote(ticketsDir, "tickets/booking-api/book-seats", "person", "The refund rule is wrong for Gold members: PRIVATE-NOTE-7731.");
  messenger = await projectSnapshot(messengerDir);
  tickets = await projectSnapshot(ticketsDir);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const pageOf = (snapshot: ProjectSnapshot, data = exportData(snapshot, look, { date: DATE, home: HOME })) =>
  exportPage({ index, css, script: SCRIPT }, data, [snapshot.dir, HOME]);

/** The data a page carries, read back the way its script reads it. */
function carried(page: string): ExportData {
  const found = /<script type="application\/json" id="fragmentor-export">([\s\S]*?)<\/script>/.exec(page);
  expect(found).not.toBeNull();
  expect(found![1]).not.toContain("<");
  return JSON.parse(found![1]!) as ExportData;
}

describe("what an exported page carries", () => {
  it("carries the drawing and the written-down executions, and nothing that stays home", () => {
    for (const [snapshot, executions] of [[messenger, 5], [tickets, 4]] as const) {
      const { snapshot: shared, problems, exported } = carried(pageOf(snapshot));

      expect(shared.dir).toBe("");
      expect(shared.notes).toEqual([]);
      expect(shared.rules).toEqual([]);
      expect(shared.diagnostics).toEqual([]);
      expect(shared.reachUnpointed).toEqual([]);
      // Who reaches whom travels, so Used by and the measurements are the same on the page.
      expect(shared.reachSeen).toHaveLength(snapshot.reachSeen.length);
      expect(Object.keys(shared.functions)).toEqual(Object.keys(snapshot.functions));
      expect(shared.systems.map((system) => system.reachNotReadBecause)).toEqual([null]);
      expect(Object.keys(shared.blocks).sort()).toEqual(Object.keys(snapshot.blocks).sort());
      for (const block of Object.values(shared.blocks)) {
        expect(block.cases).toEqual([]);
        expect(block.stores).toEqual([]);
        expect(block.sources).toEqual({ code: null, contract: null });
        expect(block.reachNotChecked).toEqual([]);
        if (block.code) expect([block.code.excerpt, block.code.hash]).toEqual([null, null]);
        for (const port of [...block.inputs, ...block.outputs]) expect(port.typeIr).toEqual({ kind: "unknown" });
      }

      expect(shared.executions).toHaveLength(executions);
      for (const execution of shared.executions) {
        expect([execution.given, execution.expect, execution.records, execution.unrecordable]).toEqual([{}, null, null, null]);
        // What the agent wrote down travels as it was written.
        const original = snapshot.executions.find((each) => each.id === execution.id)!;
        expect(execution.declared?.events).toEqual(original.declared?.events);
      }

      const errors = snapshot.diagnostics.filter((each) => each.severity === "error").length;
      expect(problems).toEqual({ errors, warnings: snapshot.diagnostics.length - errors });
      expect(exported).toBe(DATE);
    }
  });

  it("still makes a page of a snapshot from before who-reaches-whom was on it", () => {
    const before = { ...tickets } as Partial<ProjectSnapshot>;
    delete before.reachSeen;
    delete before.functions;
    const { snapshot: shared } = carried(pageOf(before as ProjectSnapshot));
    expect(shared.reachSeen).toBeUndefined();
  });

  it("leaves out notes and code, though it keeps where the code is", async () => {
    // The note really is in what the page was made from.
    expect(JSON.stringify(tickets.notes)).toContain("PRIVATE-NOTE-7731");
    const page = pageOf(tickets);
    expect(page).not.toContain("PRIVATE-NOTE-7731");

    const code = await readFile(path.join(ticketsDir, "src", "booking", "price-seat.ts"), "utf8");
    // Any line of the code itself that is not where it points.
    const body = code.split("\n").map((line) => line.trim()).filter((line) => line.length > 25 && !line.startsWith("import"));
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) expect(page).not.toContain(line);
    expect(page).toContain("src/booking/price-seat.ts#priceSeat");
  });

  it("writes the home folder as ~ wherever the agent wrote it, in any case and with either slash", () => {
    const planted = structuredClone(tickets);
    const step = planted.executions[0]!.declared!.events.find((each) => each.type === "interaction")!;
    (step as { payload?: unknown }).payload = {
      file: `${HOME}\\Documents\\orders.json`,
      [`c:/users/testperson/keys`]: "C:/USERS/TESTPERSON/.ssh/id",
    };
    const data = exportData(planted, look, { date: DATE, home: HOME });
    const payload = (data.snapshot.executions[0]!.declared!.events.find((each) => each.id === step.id) as { payload?: unknown }).payload;
    expect(payload).toEqual({ file: "~\\Documents\\orders.json", "~/keys": "~/.ssh/id" });
    // And the snapshot it was made from is untouched.
    expect((step as { payload?: unknown }).payload).toMatchObject({ file: `${HOME}\\Documents\\orders.json` });
  });

  it("finds a folder however a path writes it, and only that folder", () => {
    const planted = structuredClone(tickets);
    const said = (text: string) => {
      planted.goal = text;
      return exportData(planted, look, { date: DATE, home: HOME }).snapshot.goal;
    };
    // Git Bash, WSL, no drive, a file URL with its space encoded, and a sentence's full stop.
    expect(said("see /c/Users/Testperson/Documents/x.pdf")).toBe("see ~/Documents/x.pdf");
    expect(said("see /mnt/c/Users/Testperson/x")).toBe("see ~/x");
    expect(said("see \\Users\\Testperson\\x")).toBe("see ~\\x");
    expect(said("open file:///C:/Users/Testperson/My%20Files/x")).toBe("open ~/My%20Files/x");
    expect(said(`It lives in ${HOME}.`)).toBe("It lives in ~.");
    // A neighbour whose name only starts the same is someone else's.
    expect(said("C:\\Users\\Testpersonal\\x")).toBe("C:\\Users\\Testpersonal\\x");
    expect(said(`${tickets.dir}-old${path.sep}db.json`)).toBe(`${tickets.dir}-old${path.sep}db.json`);
  });

  it("finds a folder of one name only with its drive, so the same name elsewhere in a path is left alone", () => {
    const planted = structuredClone(tickets);
    planted.dir = "D:\\api";
    planted.goal = "POST /api/messages answers from src/api/auth.ts#check, kept at D:\\api\\src and /d/api/docs";
    // A block path ending in the same name is the project's own, and stays whole.
    planted.blocks["tickets/api"] = { ...planted.blocks["tickets"]!, path: "tickets/api" };
    const shared = exportData(planted, look, { date: DATE, home: HOME }).snapshot;
    expect(shared.goal).toBe("POST /api/messages answers from src/api/auth.ts#check, kept at src and docs");
    expect(Object.keys(shared.blocks)).toContain("tickets/api");
    expect(Object.keys(shared.blocks)).toContain("tickets");

    // On a disk with no drive letters, one name alone names nobody, and is not looked for.
    planted.dir = "/srv";
    planted.goal = "served from /srv/app";
    expect(exportData(planted, look, { date: DATE, home: HOME }).snapshot.goal).toBe("served from /srv/app");
  });

  it("takes the deeper folder out first, so one inside the other is never cut short", () => {
    const planted = structuredClone(tickets);
    planted.dir = "C:\\Users";
    planted.goal = "keys in C:\\Users\\Testperson\\Documents\\keys.txt, and C:\\Users\\shared\\x";
    expect(exportData(planted, look, { date: DATE, home: HOME }).snapshot.goal).toBe("keys in ~\\Documents\\keys.txt, and shared\\x");
  });

  it("keeps only the file of a code pointer that leads out of the project", () => {
    const planted = structuredClone(tickets);
    const seat = planted.blocks["tickets/booking-api/pricing/price-seat"]!;
    seat.files = { ...seat.files, code: "D:/work/acme-shared/pricing.ts#price" };
    seat.code = { ...seat.code!, pointer: "\\\\fileserver\\clients\\acme\\pricing.ts#price", file: "\\\\fileserver\\clients\\acme\\pricing.ts" };
    planted.executions[0]!.trigger.code = "/Volumes/Clients/Acme/run.ts#go";
    const shared = carried(pageOf(planted)).snapshot;
    const copied = shared.blocks["tickets/booking-api/pricing/price-seat"]!;
    expect(copied.files.code).toBe("…/pricing.ts#price");
    expect(copied.code!.pointer).toBe("…/pricing.ts#price");
    expect(shared.executions[0]!.trigger.code).toBe("…/run.ts#go");
    // A pointer inside the project, written whole, keeps where it is in the project.
    const inside = structuredClone(tickets);
    inside.executions[0]!.trigger.code = `${tickets.dir}${path.sep}src${path.sep}booking${path.sep}book-seats.ts#bookSeats`;
    expect(exportData(inside, look, { date: DATE, home: HOME }).snapshot.executions[0]!.trigger.code).toBe(
      `src${path.sep}booking${path.sep}book-seats.ts#bookSeats`,
    );
  });

  it("takes the project's own folder out of what the agent wrote", () => {
    const planted = structuredClone(tickets);
    planted.blocks["tickets"]!.responsibility = `Everything under ${tickets.dir}${path.sep}src, with the box office.`;
    const shared = carried(pageOf(planted)).snapshot;
    expect(shared.blocks["tickets"]!.responsibility).toBe("Everything under src, with the box office.");
  });

  it("refuses a page that would still carry a folder, whatever slipped through", () => {
    const data = exportData(tickets, look, { date: DATE, home: HOME });
    // As if something had put the folder back after the scrub, JSON-escaped.
    data.snapshot.goal = `see ${tickets.dir}`;
    expect(() => exportPage({ index, css, script: SCRIPT }, data, [tickets.dir, HOME])).toThrow(ExportLeakError);
    data.snapshot.goal = "see c:\\users\\TESTPERSON\\notes";
    expect(() => exportPage({ index, css, script: SCRIPT }, data, [tickets.dir, HOME])).toThrow(ExportLeakError);
    // However the path is spelled.
    data.snapshot.goal = "see /c/Users/Testperson/notes";
    expect(() => exportPage({ index, css, script: SCRIPT }, data, [tickets.dir, HOME])).toThrow(ExportLeakError);
    data.snapshot.goal = "see Users/Testperson in passing";
    expect(() => exportPage({ index, css, script: SCRIPT }, data, [tickets.dir, HOME])).not.toThrow();
  });
});

describe("the page itself", () => {
  it("keeps hostile text intact as data, never as markup", () => {
    const hostile = structuredClone(tickets);
    hostile.name = `<!-- "Tickets" $& $1 </title>`;
    hostile.blocks["tickets"]!.responsibility = "</script><script>alert(1)</script> <!-- $' $`";
    const page = pageOf(hostile);

    const shared = carried(page).snapshot;
    expect(shared.name).toBe(hostile.name);
    expect(shared.blocks["tickets"]!.responsibility).toBe(hostile.blocks["tickets"]!.responsibility);
    // The data element and the script, and nothing else that could run.
    expect(page.match(/<script\b/g)).toHaveLength(2);
    expect(page).toContain("<title>&lt;!-- &quot;Tickets&quot; $&amp; $1 &lt;/title&gt;</title>");
  });

  it("lets in its own script and styles by their hashes, and nothing else", () => {
    const page = pageOf(tickets);
    const policy = /content="(default-src 'none';[^"]*)"/.exec(page)![1]!;
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
    expect(policy).toContain(`script-src ${hash(SCRIPT)}`);
    expect(policy).toContain(`style-src ${hash(css.replace(/\r\n/g, "\n"))}`);
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain("'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(page).toContain(`<style>${css.replace(/\r\n/g, "\n")}</style>`);
    expect(page).not.toContain("./app.js");
    expect(page).not.toContain("styles.css");
    expect(page).toContain(`<body data-export data-project="open">`);
  });

  it("makes the same page from markup a Windows checkout gave CRLF line endings", () => {
    const data = exportData(tickets, look, { date: DATE, home: HOME });
    const crlf = { index: index.replace(/\r?\n/g, "\r\n"), css: css.replace(/\r?\n/g, "\r\n"), script: SCRIPT };
    expect(exportPage(crlf, data, [tickets.dir, HOME])).toBe(exportPage({ index, css, script: SCRIPT }, data, [tickets.dir, HOME]));
  });

  it("refuses markup it cannot place the page in, and a script or styles that would end their own element", () => {
    const data = exportData(tickets, look, { date: DATE, home: HOME });
    const make = (assets: { index: string; css: string; script: string }) => () => exportPage(assets, data, [tickets.dir, HOME]);
    expect(make({ index: index.replace("<title>Fragmentor</title>", ""), css, script: SCRIPT })).toThrow(ExportPageError);
    expect(make({ index: index.replace("<body>", "<body><body>"), css, script: SCRIPT })).toThrow(/2 of "<body>"/);
    expect(make({ index, css, script: "x = '</SCRIPT>';" })).toThrow(ExportPageError);
    expect(make({ index, css, script: "x = '<!--';" })).toThrow(ExportPageError);
    expect(make({ index, css: `${css}\n/* </style> */`, script: SCRIPT })).toThrow(ExportPageError);
  });
});

describe("the look a page opens with", () => {
  it("keeps only colours that are colours, blocks and an execution the project has", () => {
    const execution = tickets.executions[0]!;
    const checked = checkLook(
      {
        colourBy: "role",
        roleColours: { function: "#12ab34", database: "red;}", nothing: "#000000" },
        blockColours: { "tickets/box-office": "#ABCDEF", "tickets/gone": "#111111" },
        showDependencies: "yes",
        legendCollapsed: true,
        folded: ["tickets/booking-api", "tickets/gone", 7, "tickets/booking-api"],
        execution: { id: execution.id, at: 2 },
      },
      tickets,
    );
    expect(checked).toEqual({
      colourBy: "role",
      roleColours: { function: "#12ab34" },
      blockColours: { "tickets/box-office": "#ABCDEF" },
      showDependencies: false,
      legendCollapsed: true,
      folded: ["tickets/booking-api"],
      execution: { id: execution.id, at: 2 },
    });

    expect(checkLook({ execution: { id: "no-such", at: 0 } }, tickets).execution).toBeNull();
    expect(checkLook({ execution: { id: execution.id, at: 999 } }, tickets).execution).toEqual({ id: execution.id, at: 0 });
    expect(checkLook("not a look", tickets)).toEqual(look);
  });

  it("names the file something every disk will take", () => {
    expect(saveName("A/B: test?")).toBe("A-B- test-");
    expect(saveName("Tickets")).toBe("Tickets");
    expect(saveName(" ..  ")).toBe("project");
    expect(saveName("a<b>c|d*e\"f")).toBe("a-b-c-d-e-f");
  });
});
