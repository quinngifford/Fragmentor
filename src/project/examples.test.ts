import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { holdsArchitecture, languageOf, loadProject, resolveAccess, validateProject } from "./project.js";
import { executionOrder } from "../model/validate.js";
import { describeType } from "../model/types.js";
import { boundStores, describeBound } from "./stores.js";
import { runBlock } from "../run/run.js";

/**
 * The example projects are checked in exactly as an agent would leave them,
 * so they are the closest thing to real use the suite has. These tests hold
 * them to the rules, and use them to exercise the parts of the model that are
 * easy to get wrong.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");
const jobRanker = path.join(examples, "job-ranker");

describe("the job-ranker example", () => {
  it("reads off disk and validates cleanly", async () => {
    const project = await loadProject(jobRanker);
    expect(validateProject(project)).toEqual([]);

    expect([...project.byPath.keys()].sort()).toEqual([
      "embed-postings",
      "embed-postings/clean-text",
      "embed-postings/embed-text",
      "rank-jobs",
      "rank-jobs/extract-profile-keywords",
      "rank-jobs/load-postings",
      "rank-jobs/rank-results",
      "rank-jobs/score-posting",
      "rank-jobs/score-posting/compute-relevance",
      "rank-jobs/score-posting/match-keywords",
      "rank-jobs/score-posting/normalize-text",
    ]);
  });

  it("carries the file capability down to the only block that needs it", async () => {
    const project = await loadProject(jobRanker);

    expect(project.byPath.get("rank-jobs")!.block.capabilities.files?.capability).toBe("FileSystem");
    expect(project.byPath.get("rank-jobs/load-postings")!.block.capabilities.files?.capability).toBe("FileSystem");
    // Nothing else needed it, so nothing else claims it.
    expect(project.byPath.get("rank-jobs/rank-results")!.block.capabilities).toEqual({});
  });

  it("keeps the per-posting scorer a single-item block despite array wiring", async () => {
    const project = await loadProject(jobRanker);

    const root = project.byPath.get("rank-jobs")!.block;
    expect(root.children).toContainEqual({ block: "score-posting", mode: "each", eachOver: "posting" });

    // The scorer itself knows nothing about arrays; `each` supplies the arity.
    const scorer = project.byPath.get("rank-jobs/score-posting")!.block;
    expect(scorer.inputs.posting!.type.kind).toBe("object");
    expect(scorer.outputs.score!.type.kind).toBe("number");
  });

  it("orders the root's children so every value exists before it is used", async () => {
    const root = (await loadProject(jobRanker)).byPath.get("rank-jobs")!.block;

    const order = executionOrder(root.children, root.wires);
    expect(order).toHaveLength(4);
    expect(order.indexOf("load-postings")).toBeLessThan(order.indexOf("score-posting"));
    expect(order.indexOf("extract-profile-keywords")).toBeLessThan(order.indexOf("score-posting"));
    expect(order.indexOf("score-posting")).toBeLessThan(order.indexOf("rank-results"));
  });

  it("lets one output feed two different destinations", async () => {
    const root = (await loadProject(jobRanker)).byPath.get("rank-jobs")!.block;

    const fromPostings = root.wires.filter(
      (w) => w.source.from === "block" && w.source.block === "load-postings" && w.source.port === "postings",
    );
    expect(fromPostings).toHaveLength(2);
  });

  it("keeps two systems side by side, each in its own language", async () => {
    const project = await loadProject(jobRanker);

    expect(project.systems.map((s) => [s.rootBlock, s.language])).toEqual([
      ["rank-jobs", "typescript"],
      ["embed-postings", "python"],
    ]);

    // A block's language follows the system it sits in.
    expect(languageOf(project, "rank-jobs/score-posting/match-keywords")).toBe("typescript");
    expect(languageOf(project, "embed-postings/embed-text")).toBe("python");
  });

  it("notices when a child's contract drifts from what its parent wires to it", async () => {
    const project = await loadProject(jobRanker);

    // Someone edits a child's contract without updating the parent.
    const scorer = project.byPath.get("rank-jobs/score-posting")!;
    const matcher = scorer.children.find((c) => c.block.id === "match-keywords")!;
    matcher.block.outputs.matches = { type: { kind: "string" } };

    expect(validateProject(project).map((d) => d.message)).toContainEqual(expect.stringContaining("Type mismatch"));
  });
});

describe("the support-desk example", () => {
  const supportDesk = path.join(examples, "support-desk");

  it("puts a whole architecture over blocks that are still generated and run", async () => {
    const project = await loadProject(supportDesk);
    expect(validateProject(project)).toEqual([]);

    const roleOf = (blockPath: string) => project.byPath.get(blockPath)!.block.role;
    expect(roleOf("support-desk/agent-console")).toBe("client");
    expect(roleOf("support-desk/triage")).toBe("service");
    expect(roleOf("support-desk/accounts-file")).toBe("storage");
    expect(roleOf("support-desk/alerts")).toBe("queue");

    // The request path inside the service is an ordinary composite, which is
    // the whole point: it can be generated, checked, run and paused.
    const path4 = "support-desk/triage/triage-ticket";
    expect(holdsArchitecture(project.byPath.get(path4)!)).toBe(false);
    expect(project.byPath.get(path4)!.block.kind).toBe("composite");
  });

  it("names what each piece of the architecture is exactly", async () => {
    const project = await loadProject(supportDesk);
    const subtypeOf = (blockPath: string) => project.byPath.get(blockPath)!.block.subtype;

    expect(subtypeOf("support-desk/triage")).toBe("REST API");
    expect(subtypeOf("support-desk/accounts-file")).toBe("JSON file");
    expect(subtypeOf("support-desk/alerts")).toBe("notification topic");
  });

  it("reaches the accounts file from the one block whose code really reads it", async () => {
    const project = await loadProject(supportDesk);
    const loader = "support-desk/triage/triage-ticket/load-account";

    // The access names the capability port at this end, which is what makes
    // the line on the diagram the same line the code runs along: the port is
    // a way into that entry and nothing else.
    const block = project.byPath.get(loader)!.block;
    expect(block.access).toEqual([{ from: "accounts", verb: "reads", resource: "accounts-file", entry: "accounts" }]);
    expect(block.capabilities.accounts?.capability).toBe("Store");
    expect(resolveAccess(project, loader, "accounts-file")?.path).toBe("support-desk/accounts-file");
  });

  it("types the store by what the block it reaches says it holds", async () => {
    const project = await loadProject(supportDesk);
    const node = project.byPath.get("support-desk/triage/triage-ticket/load-account")!;

    const [store] = boundStores(project, node);
    expect(store).toMatchObject({
      port: "accounts",
      capability: "Store",
      target: "support-desk/accounts-file.accounts",
      entry: "accounts",
      seedable: true,
    });
    expect(describeBound(store!)).toBe("Store<{ id: string; name: string; plan: string; openTickets: number }>");
  });

  it("gives an operation the shape of the block that answers it", async () => {
    const project = await loadProject(supportDesk);
    const operation = project.byPath.get("support-desk/triage")!.block.exposes.triageTicket!;
    const answering = project.byPath.get("support-desk/triage/triage-ticket")!.block;

    // No mapping stands between the two: what arrives at the edge of the
    // service is what the block takes, so following the route and running it
    // are the same journey.
    expect(operation.block).toBe("triage-ticket");
    expect(describeType(operation.accepts!)).toBe(
      describeType({
        kind: "object",
        fields: Object.fromEntries(Object.entries(answering.inputs).map(([name, port]) => [name, { type: port.type }])),
      }),
    );
    expect(describeType(operation.returns!)).toBe(
      describeType({
        kind: "object",
        fields: Object.fromEntries(Object.entries(answering.outputs).map(([name, port]) => [name, { type: port.type }])),
      }),
    );
  });
});

describe("the contract-generator example", () => {
  it("reads off disk and validates cleanly", async () => {
    expect(validateProject(await loadProject(path.join(examples, "contract-generator")))).toEqual([]);
  });
});

describe("the link-shortener example", () => {
  const linkShortener = path.join(examples, "link-shortener");

  it("draws a whole application, not just its functions, and validates cleanly", async () => {
    const project = await loadProject(linkShortener);
    expect(validateProject(project)).toEqual([]);

    const roleOf = (blockPath: string) => project.byPath.get(blockPath)!.block.role;
    expect(roleOf("link-shortener/browser")).toBe("client");
    expect(roleOf("link-shortener/api")).toBe("service");
    expect(roleOf("link-shortener/links-db")).toBe("database");
    expect(roleOf("link-shortener/click-events")).toBe("queue");
    expect(roleOf("link-shortener/geo-lookup")).toBe("external");
    // What the service is made of stays ordinary blocks.
    expect(roleOf("link-shortener/api/follow-link/resolve-link")).toBe("function");

    // Nothing in the code calls a geolocation provider, so the block that
    // stands for one is part of the plan rather than of the program.
    expect(project.byPath.get("link-shortener/geo-lookup")!.block.planned).toBe(true);
  });

  it("shows a table as its columns, which is what makes the database worth drawing", async () => {
    const project = await loadProject(linkShortener);
    const links = project.byPath.get("link-shortener/links-db")!.block.exposes.links!;

    expect(describeType(links.returns!)).toBe("{ code: string; url: string; owner: string; createdAt: number }");
    // A store gives back what it was given, so the file wrote the shape once.
    expect(links.accepts).toEqual(links.returns);
  });

  it("joins a handler to a database two levels further out than itself", async () => {
    const project = await loadProject(linkShortener);
    const path = "link-shortener/api/follow-link/resolve-link";
    const resolve = project.byPath.get(path)!.block;

    expect(resolve.access).toEqual([{ from: null, verb: "reads", resource: "links-db", entry: "links" }]);
    // links-db sits beside the service, past the request path and the service.
    expect(resolveAccess(project, path, "links-db")?.path).toBe("link-shortener/links-db");
  });

  it("leaves the whole application and its service with no code of their own", async () => {
    const project = await loadProject(linkShortener);
    const at = (blockPath: string) => holdsArchitecture(project.byPath.get(blockPath)!);

    expect(at("link-shortener")).toBe(true);
    expect(at("link-shortener/api")).toBe(true);
    expect(at("link-shortener/api/create-link")).toBe(false);
    expect(at("link-shortener/api/follow-link")).toBe(false);
  });
});

describe("the lending-desk example", () => {
  const lendingDesk = path.join(examples, "lending-desk");

  it("draws a whole application whose stores its code really reaches", async () => {
    const project = await loadProject(lendingDesk);
    expect(validateProject(project)).toEqual([]);

    const roleOf = (blockPath: string) => project.byPath.get(blockPath)!.block.role;
    expect(roleOf("lending/kiosk")).toBe("client");
    expect(roleOf("lending/lending-api")).toBe("service");
    expect(roleOf("lending/catalogue")).toBe("database");
    expect(roleOf("lending/notices")).toBe("queue");
  });

  it("gives the request path a way into each thing it touches", async () => {
    const project = await loadProject(lendingDesk);
    const node = project.byPath.get("lending/lending-api/borrow-book")!;

    expect(boundStores(project, node).map((store) => [store.port, store.capability, store.target])).toEqual([
      ["books", "Store", "lending/catalogue.books"],
      ["members", "Store", "lending/catalogue.members"],
      ["notices", "Queue", "lending/notices.issued"],
    ]);
  });

  it("runs the whole way from the kiosk's request, writing the shelf and the queue", async () => {
    const outcome = await runBlock({
      projectDir: lendingDesk,
      blockPath: "lending/lending-api/borrow-book",
      input: { memberId: "m-1", isbn: "978-1" },
      stores: {
        "lending/catalogue.books": { "978-1": { isbn: "978-1", title: "Piranesi", copies: 1, onLoan: 0 } },
        "lending/catalogue.members": { "m-1": { id: "m-1", name: "Ada", onLoan: 0, suspended: false } },
      },
    });

    expect(outcome.error).toBeUndefined();
    expect(outcome.output).toEqual({
      receipt: {
        title: "Piranesi",
        dueInDays: 7,
        message: 'Enjoy "Piranesi". Back in 7 days, because the library holds only one copy — 0 left on the shelf.',
      },
    });

    // The book left the shelf, and the member was told about it: neither is
    // visible in what the block returned.
    expect(outcome.stores["lending/catalogue.books"]).toEqual({
      kind: "store",
      rows: { "978-1": { isbn: "978-1", title: "Piranesi", copies: 1, onLoan: 1 } },
    });
    expect(outcome.stores["lending/notices.issued"]).toEqual({
      kind: "queue",
      sent: [{ memberId: "m-1", title: "Piranesi", dueInDays: 7 }],
    });
  });

  it("puts a block where the shapes would otherwise have to be converted", async () => {
    const project = await loadProject(lendingDesk);
    const path_ = "lending/lending-api/borrow-book";

    // The pipeline produces facts; one block turns them into the response,
    // which is what lets the operation and the block be the same shape.
    const adapter = project.byPath.get(`${path_}/write-receipt`)!.block;
    expect(Object.keys(adapter.inputs).sort()).toEqual(["allowed", "book", "copiesLeft", "dueInDays", "reason"]);
    expect(Object.keys(adapter.outputs)).toEqual(["receipt"]);
    expect(Object.keys(project.byPath.get(path_)!.block.outputs)).toEqual(["receipt"]);
  });
});
