import { appendFile, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyPlan, blockVersions, swapToVersion, undoLastSwap } from "./history.js";
import { commitExampleHistory, filesOf, gitIn } from "./exampleHistory.js";

/**
 * A block's versions come from a real git repository here, because what is
 * being tested is how git is asked: from a project that is a subfolder of its
 * repository, with spaces in both names, and with line endings converted as
 * they are by default on Windows, so a file differing only in those is met as
 * it is met there.
 */

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

const pricing = "tickets/booking-api/pricing";
const priceSeat = `${pricing}/price-seat`;
const refundFor = `${pricing}/refund-for`;
const PRICING = `blocks/${pricing}`;

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A folder for one test, removed afterwards. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fragmentor history "));
  made.push(dir);
  return dir;
}

/**
 * The repository `work space`, holding the tickets example as `tickets app`,
 * with the two versions of pricing the self-check uses. It is built once and
 * copied for each test, which takes a quarter of the time.
 */
let built: { repo: string; older: string; newer: string };
let builtIn: string | undefined;

beforeAll(async () => {
  builtIn = await mkdtemp(path.join(tmpdir(), "fragmentor history "));
  const repo = path.join(builtIn, "work space");
  await cp(path.join(examples, "tickets"), path.join(repo, "tickets app"), { recursive: true });
  await gitIn(repo)("init", "--quiet");
  await gitIn(repo)("config", "core.autocrlf", "true");
  built = { repo, ...(await commitExampleHistory(path.join(repo, "tickets app"))) };
}, 30_000);

afterAll(async () => {
  if (builtIn !== undefined) await rm(builtIn, { recursive: true, force: true });
});

async function ticketsHistory() {
  const repo = path.join(await scratch(), "work space");
  await cp(built.repo, repo, { recursive: true });
  const dir = path.join(repo, "tickets app");
  return { repo, dir, git: gitIn(dir), older: built.older, newer: built.newer };
}

/** Writes a project file, making its folder if need be. */
async function put(dir: string, file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), contents, "utf8");
}

/** A project file's text, with a checkout's line endings read as the ones it was written with. */
const text = async (dir: string, file: string) => (await readFile(path.join(dir, file), "utf8")).replace(/\r\n/g, "\n");

const there = (dir: string, file: string) => stat(path.join(dir, file)).then(() => true, () => false);

const head = async (git: ReturnType<typeof gitIn>) => (await git("rev-parse", "HEAD")).trim();

const record = async (dir: string, n: number) =>
  JSON.parse(await readFile(path.join(dir, ".fragmentor", "swaps", String(n), "swap.json"), "utf8"));

describe("a block's versions", () => {
  it("are the commits that changed it, newest first", async () => {
    const { dir, older, newer } = await ticketsHistory();

    const listed = await blockVersions(dir, pricing);
    expect(listed.versions.map((version) => [version.commit, version.subject])).toEqual([
      [newer, "Take ten percent off from the fifth seat"],
      [older, "Price seats with a discount from the third seat"],
    ]);
    expect(listed.versions[0]).toMatchObject({ author: "Fragmentor", date: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(listed).toMatchObject({ unavailable: null, more: false, changed: false, blocked: null, swapped: null });
  }, 30_000);

  it("say when the block has changed since the newest of them, and not when only line endings have", async () => {
    const { dir } = await ticketsHistory();

    const code = await readFile(path.join(dir, "src", "booking", "price-seat.ts"));
    await appendFile(path.join(dir, "src", "booking", "price-seat.ts"), "// changed\n");
    expect((await blockVersions(dir, pricing)).changed).toBe(true);
    await writeFile(path.join(dir, "src", "booking", "price-seat.ts"), code);

    await put(dir, `${PRICING}/extra/block.json`, JSON.stringify({ role: "component", responsibility: "Something new." }));
    expect((await blockVersions(dir, pricing)).changed).toBe(true);
    await rm(path.join(dir, PRICING, "extra"), { recursive: true });

    const file = path.join(dir, PRICING, "refund-for", "block.json");
    await writeFile(file, (await readFile(file, "utf8")).replace(/\r?\n/g, "\r\n"), "utf8");
    expect((await blockVersions(dir, pricing)).changed).toBe(false);
  }, 30_000);

  it("include a commit that changed only the code of one of its parts, for the parts that point at it", async () => {
    const { dir, git, older, newer } = await ticketsHistory();

    await appendFile(path.join(dir, "src", "booking", "refund-for.ts"), "// the fee stays\n");
    await git("commit", "--quiet", "-am", "Say the fee stays");
    const third = await head(git);

    expect((await blockVersions(dir, pricing)).versions.map((version) => version.commit)).toEqual([third, newer, older]);
    expect((await blockVersions(dir, refundFor)).versions.map((version) => version.commit)).toEqual([third, older]);
    expect((await blockVersions(dir, priceSeat)).versions.map((version) => version.commit)).toEqual([newer, older]);
  }, 30_000);

  it("start at the commit that added the block, however much older its code is", async () => {
    const { dir, git } = await ticketsHistory();

    await put(dir, "src/booking/hold-seats.ts", "export async function holdSeats() {}\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Write a helper");
    await put(dir, `${PRICING}/hold-seats/block.json`, JSON.stringify({ responsibility: "Hold seats.", code: "src/booking/hold-seats.ts#holdSeats" }));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Draw the helper as a block");
    const drawn = await head(git);
    await appendFile(path.join(dir, "src", "booking", "hold-seats.ts"), "// changed\n");
    await git("commit", "--quiet", "-am", "Change the helper");
    const changed = await head(git);

    expect((await blockVersions(dir, `${pricing}/hold-seats`)).versions.map((version) => version.commit)).toEqual([changed, drawn]);
  }, 30_000);

  it("start again where the block's folder moved", async () => {
    const { dir, git } = await ticketsHistory();

    await git("mv", `${PRICING}/refund-for`, "blocks/tickets/booking-api/refund-for");
    await git("commit", "--quiet", "-m", "Take refunds out of pricing");
    const moved = await head(git);

    expect((await blockVersions(dir, "tickets/booking-api/refund-for")).versions.map((version) => version.commit)).toEqual([moved]);
  }, 30_000);

  it("are the same whatever the person's own git settings add to a log", async () => {
    const { dir, git, older, newer } = await ticketsHistory();
    await git("mv", `${PRICING}/refund-for`, "blocks/tickets/booking-api/refund-for");
    await git("commit", "--quiet", "-m", "Take refunds out of pricing");
    const moved = await head(git);
    // None of these commits is signed, so showing signatures adds nothing
    // here; following a file back past its move is what would.
    await git("config", "log.showSignature", "true");
    await git("config", "log.follow", "true");
    await git("config", "color.ui", "always");

    expect((await blockVersions(dir, "tickets/booking-api/refund-for")).versions.map((version) => version.commit)).toEqual([moved]);
    expect((await blockVersions(dir, pricing)).versions.map((version) => version.commit)).toEqual([moved, newer, older]);
  }, 30_000);

  it("are only the commits after the one that added it, when it was added on a branch merged in later", async () => {
    const { dir, git } = await ticketsHistory();
    const helper = "src/booking/hold-seats.ts";
    const block = (responsibility: string) => JSON.stringify({ responsibility, code: `${helper}#holdSeats` });
    await put(dir, helper, "export async function holdSeats() {}\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Write a helper");

    await git("checkout", "--quiet", "-b", "draw-the-helper");
    await put(dir, `${PRICING}/hold-seats/block.json`, block("Hold seats."));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Draw the helper as a block");
    const drawn = await head(git);
    await put(dir, `${PRICING}/hold-seats/block.json`, block("Hold the seats asked for."));
    await git("commit", "--quiet", "-am", "Say which seats");
    const said = await head(git);

    // Meanwhile the helper changes where the block does not exist yet.
    await git("checkout", "--quiet", "-");
    await appendFile(path.join(dir, helper), "// changed beside the branch\n");
    await git("commit", "--quiet", "-am", "Change the helper");
    await git("merge", "--quiet", "--no-ff", "-m", "Bring in the drawing", "draw-the-helper");
    const merged = await head(git);

    expect((await blockVersions(dir, `${pricing}/hold-seats`)).versions.map((version) => version.commit)).toEqual([merged, said, drawn]);
  }, 30_000);

  it("are found for a block first committed in a merge", async () => {
    const { dir, git } = await ticketsHistory();
    const helper = "src/booking/hold-seats.ts";
    await put(dir, helper, "export async function holdSeats() {}\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Write a helper");
    await git("checkout", "--quiet", "-b", "aside");
    await put(dir, "notes.txt", "Something aside.\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Note something aside");
    await git("checkout", "--quiet", "-");

    await git("merge", "--quiet", "--no-ff", "--no-commit", "aside");
    await put(dir, `${PRICING}/hold-seats/block.json`, JSON.stringify({ responsibility: "Hold seats.", code: `${helper}#holdSeats` }));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Draw the helper while merging");
    const merged = await head(git);
    await appendFile(path.join(dir, helper), "// changed\n");
    await git("commit", "--quiet", "-am", "Change the helper");
    const changed = await head(git);

    // Commits of its code from before the merge can follow: git gives no
    // way to tell where a block added in a merge began.
    const listed = (await blockVersions(dir, `${pricing}/hold-seats`)).versions.map((version) => version.commit);
    expect(listed.slice(0, 2)).toEqual([changed, merged]);
  }, 30_000);

  it("are still listed when a swap's record was cut short, as an application stopped while writing it leaves it", async () => {
    const { dir, older, newer } = await ticketsHistory();
    await swapToVersion(dir, pricing, older);
    const file = path.join(dir, ".fragmentor", "swaps", "1", "swap.json");
    await writeFile(file, (await readFile(file, "utf8")).slice(0, 40));

    const listed = await blockVersions(dir, pricing);
    expect(listed).toMatchObject({ unavailable: null, swapped: null });
    expect(listed.versions.map((version) => version.commit)).toEqual([newer, older]);
  }, 30_000);

  it("cannot come from a folder in no repository, and say so", async () => {
    const dir = path.join(await scratch(), "no repo here");
    await cp(path.join(examples, "tickets"), dir, { recursive: true });

    expect(await blockVersions(dir, pricing)).toMatchObject({
      unavailable:
        "Versions come from the project's git history, and this folder is not in a git repository yet. Ask your agent to put it under git and commit.",
      versions: [],
    });
  });

  it("are none yet in a repository with no commits", async () => {
    const dir = path.join(await scratch(), "fresh project");
    await cp(path.join(examples, "tickets"), dir, { recursive: true });
    await gitIn(dir)("init", "--quiet");

    expect(await blockVersions(dir, pricing)).toMatchObject({ unavailable: null, versions: [], more: false, changed: true });
  });

  it("cannot come from git where it is not installed, and say so", async () => {
    const dir = path.join(await scratch(), "tickets app");
    await cp(path.join(examples, "tickets"), dir, { recursive: true });
    const nowhere = await scratch();

    const searched = process.env.PATH;
    process.env.PATH = nowhere;
    try {
      expect((await blockVersions(dir, pricing)).unavailable).toBe(
        "Versions come from git, which is not installed on this computer. Install it, then open this window again.",
      );
    } finally {
      process.env.PATH = searched;
    }
  });

  it("cannot be swapped in on their own where a function outside shares the code, and name the block that could be", async () => {
    const dir = path.join(await scratch(), "messenger app");
    await cp(path.join(examples, "messenger"), dir, { recursive: true });
    const git = gitIn(dir);
    await git("init", "--quiet");
    await git("add", "--all");
    await git("commit", "--quiet", "-m", "The messenger");

    expect((await blockVersions(dir, "app/api/auth/log-in")).blocked).toBe(
      "Swapping Log In would also change the code of Check Session and Log Out, which are not part of it: src/api/auth.ts. Compare or swap Auth, which holds them all, instead.",
    );
    // Neither the component holding them nor the service holding that is a
    // function, so neither has code of its own for a swap to change.
    expect((await blockVersions(dir, "app/api/auth")).blocked).toBeNull();
    expect((await blockVersions(dir, "app/api")).blocked).toBeNull();
  }, 30_000);

  it("count a pointer spelled in another case as sharing the code, where the disk ignores case", async () => {
    const dir = path.join(await scratch(), "messenger app");
    await cp(path.join(examples, "messenger"), dir, { recursive: true });
    const logOut = path.join(dir, "blocks", "app", "api", "auth", "log-out", "block.json");
    await writeFile(logOut, (await readFile(logOut, "utf8")).replace("src/api/auth.ts", "src/API/Auth.ts"));
    const git = gitIn(dir);
    await git("init", "--quiet");
    await git("add", "--all");
    await git("commit", "--quiet", "-m", "The messenger");

    // Elsewhere that pointer reaches no file at all, so it shares nothing.
    const folds = process.platform === "win32" || process.platform === "darwin";
    expect((await blockVersions(dir, "app/api/auth/log-in")).blocked).toBe(
      `Swapping Log In would also change the code of ${folds ? "Check Session and Log Out, which are" : "Check Session, which is"} not part of it: src/api/auth.ts. Compare or swap Auth, which holds them all, instead.`,
    );
  }, 30_000);
});

describe("swapping a block to a version", () => {
  it("puts the block, its parts and their code back as they were, and back again", async () => {
    const { dir, git, older, newer } = await ticketsHistory();
    // Nothing to do is nothing done, and nothing kept.
    expect(await swapToVersion(dir, pricing, newer)).toEqual({ changed: 0 });
    expect(await there(dir, ".fragmentor")).toBe(false);

    expect((await swapToVersion(dir, pricing, older)).changed).toBeGreaterThan(0);
    const files = (await git("ls-tree", "-r", "-z", "--name-only", older, "--", PRICING, "src/booking")).split("\0").filter(Boolean);
    const version = files.filter((file) => file.startsWith(PRICING) || /^src\/booking\/(price-seat|refund-for|seat-discount)\.ts$/.test(file));
    expect(version).toContain(`${PRICING}/seat-discount/block.json`);
    expect(version).toContain("src/booking/seat-discount.ts");
    for (const file of version) {
      expect(await text(dir, file), file).toBe((await git("cat-file", "--filters", `${older}:./${file}`)).replace(/\r\n/g, "\n"));
    }

    await swapToVersion(dir, pricing, newer);
    expect(await there(dir, `${PRICING}/seat-discount`)).toBe(false);
    expect(await there(dir, "src/booking/seat-discount.ts")).toBe(false);
    expect(await text(dir, "src/booking/price-seat.ts")).toBe((await git("cat-file", "--filters", `${newer}:./src/booking/price-seat.ts`)).replace(/\r\n/g, "\n"));

    expect(await swapToVersion(dir, pricing, newer)).toEqual({ changed: 0 });
    expect(await readdir(path.join(dir, ".fragmentor", "swaps"))).toHaveLength(2);
  }, 30_000);

  it("writes back a file that was at the path the block points at now, rather than deleting it", async () => {
    const { dir, git } = await ticketsHistory();
    const shipped = { block: await text(dir, `${PRICING}/price-seat/block.json`), code: await text(dir, "src/booking/price-seat.ts") };

    // Its code once lived elsewhere, and this path held a helper.
    await put(dir, `${PRICING}/price-seat/block.json`, shipped.block.replace("src/booking/price-seat.ts#priceSeat", "src/pricing/seat.ts#priceSeat"));
    await put(dir, "src/pricing/seat.ts", shipped.code);
    await put(dir, "src/booking/price-seat.ts", "export const HELPER = true;\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Keep the seat's price with pricing");
    const then = await head(git);
    await put(dir, `${PRICING}/price-seat/block.json`, shipped.block);
    await put(dir, "src/booking/price-seat.ts", shipped.code);
    await rm(path.join(dir, "src", "pricing"), { recursive: true });
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Keep it with booking");

    await swapToVersion(dir, pricing, then);
    expect(await text(dir, "src/booking/price-seat.ts")).toBe("export const HELPER = true;\n");
    expect(await text(dir, "src/pricing/seat.ts")).toBe(shipped.code);
  }, 30_000);

  it("swaps a path that is a file now and a part's folder then, both ways", async () => {
    const { dir, git } = await ticketsHistory();
    await put(dir, `${PRICING}/notes/block.json`, JSON.stringify({ role: "component", responsibility: "Notes on pricing." }));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Keep notes as a part");
    const folder = await head(git);
    await rm(path.join(dir, PRICING, "notes"), { recursive: true });
    await put(dir, `${PRICING}/notes`, "Prices are in pounds.\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Keep notes as a file");
    const file = await head(git);

    await swapToVersion(dir, pricing, folder);
    expect(JSON.parse(await text(dir, `${PRICING}/notes/block.json`))).toMatchObject({ responsibility: "Notes on pricing." });

    await swapToVersion(dir, pricing, file);
    expect(await text(dir, `${PRICING}/notes`)).toBe("Prices are in pounds.\n");
  }, 30_000);

  it("never touches clutter or hidden files, even in a folder it swaps", async () => {
    const { dir, git, newer } = await ticketsHistory();
    const block = JSON.parse(await text(dir, `${PRICING}/block.json`));
    await put(dir, `${PRICING}/block.json`, JSON.stringify({ ...block, code: "src/pricing" }, null, 2));
    await put(dir, "src/pricing/rates.ts", "export const RATE = 1;\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Point pricing at its own folder");
    await put(dir, `${PRICING}/__pycache__/x.pyc`, "compiled");
    await put(dir, "src/pricing/.env", "SECRET=1\n");

    await swapToVersion(dir, pricing, newer);
    expect(await there(dir, "src/pricing/rates.ts")).toBe(false);
    expect(await text(dir, `${PRICING}/__pycache__/x.pyc`)).toBe("compiled");
    expect(await text(dir, "src/pricing/.env")).toBe("SECRET=1\n");
  }, 30_000);

  it("takes a code path literally, never as a pattern matching others", async () => {
    const { dir, git } = await ticketsHistory();
    const real = "src/booking/[holds]/hold seats.ts";
    const decoy = "src/booking/h/hold seats.ts";
    await put(dir, `${PRICING}/hold-seats/block.json`, JSON.stringify({ responsibility: "Hold seats.", code: `${real}#holdSeats` }));
    await put(dir, real, "export async function holdSeats() { return 1; }\n");
    await put(dir, decoy, "decoy 1\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Hold seats");
    const first = await head(git);
    await put(dir, decoy, "decoy 2\n");
    await git("commit", "--quiet", "-am", "Change only the decoy");
    await put(dir, real, "export async function holdSeats() { return 2; }\n");
    await git("commit", "--quiet", "-am", "Hold them differently");
    const last = await head(git);
    await put(dir, decoy, "decoy now\n");

    expect((await blockVersions(dir, `${pricing}/hold-seats`)).versions.map((version) => version.commit)).toEqual([last, first]);
    await swapToVersion(dir, `${pricing}/hold-seats`, first);
    expect(await text(dir, real)).toBe("export async function holdSeats() { return 1; }\n");
    expect(await text(dir, decoy)).toBe("decoy now\n");
    expect((await record(dir, 1)).files.map((each: { path: string }) => each.path)).not.toContain(decoy);
  }, 30_000);

  it("keeps what it replaced first, where git is told never to look", async () => {
    const { dir, git, older } = await ticketsHistory();
    const code = await readFile(path.join(dir, "src", "booking", "price-seat.ts"));

    await swapToVersion(dir, pricing, older);
    expect(await record(dir, 1)).toMatchObject({
      kind: "swap",
      block: pricing,
      name: "Pricing",
      commit: older,
      subject: "Price seats with a discount from the third seat",
    });
    const files = (await record(dir, 1)).files;
    expect(files).toContainEqual({ path: "src/booking/price-seat.ts", existed: true });
    expect(files).toContainEqual({ path: "src/booking/seat-discount.ts", existed: false });
    expect(await readFile(path.join(dir, ".fragmentor", "swaps", "1", "files", "src", "booking", "price-seat.ts"))).toEqual(code);
    // Said beside the record once every change is made, never by writing it again.
    expect(await there(dir, ".fragmentor/swaps/1/done")).toBe(true);

    expect(await readFile(path.join(dir, ".fragmentor", ".gitignore"), "utf8")).toBe("*\n");
    expect(await git("status", "--porcelain", "--untracked-files=all")).not.toContain(".fragmentor");
  }, 30_000);

  it("can be undone, putting back exactly what was there, uncommitted work included", async () => {
    const { dir, older } = await ticketsHistory();
    await appendFile(path.join(dir, "src", "booking", "refund-for.ts"), "// not committed\n");
    await put(dir, `${PRICING}/notes.txt`, "not in git at all\n");
    const before = await filesOf(dir);

    await swapToVersion(dir, pricing, older);
    expect((await blockVersions(dir, pricing)).swapped).toMatchObject({ commit: older, subject: "Price seats with a discount from the third seat" });
    expect(await there(dir, `${PRICING}/notes.txt`)).toBe(false);

    expect((await undoLastSwap(dir, pricing)).changed).toBeGreaterThan(0);
    expect(await filesOf(dir)).toEqual(before);
    expect(await record(dir, 2)).toMatchObject({ kind: "undo", block: pricing, undoes: 1 });
    expect((await blockVersions(dir, pricing)).swapped).toBeNull();

    await expect(undoLastSwap(dir, pricing)).rejects.toThrow("There is no swap of Pricing to undo.");
  }, 30_000);

  it("can be undone after failing part-way, because what it replaced was kept before it began", async () => {
    const { dir, older } = await ticketsHistory();
    const before = await filesOf(dir);
    const code = path.join(dir, "src", "booking", "price-seat.ts");

    await chmod(code, 0o444);
    try {
      await expect(swapToVersion(dir, pricing, older)).rejects.toThrow(
        /^Could not write src\/booking\/price-seat\.ts: .+\. What was there before is kept: press Undo swap to put it back\.$/,
      );
    } finally {
      await chmod(code, 0o644);
    }
    expect(await there(dir, ".fragmentor/swaps/1/swap.json")).toBe(true);
    expect(await there(dir, ".fragmentor/swaps/1/done")).toBe(false);
    expect((await blockVersions(dir, pricing)).swapped).toMatchObject({ commit: older });

    // Trying again would keep a copy of the half-swapped files, not of what was there before.
    await expect(swapToVersion(dir, pricing, older)).rejects.toThrow(
      "The last swap of Pricing did not finish. Press Undo swap in its Versions window first, so what it replaced is put back.",
    );

    await undoLastSwap(dir, pricing);
    expect(await filesOf(dir)).toEqual(before);
  }, 30_000);

  it("can be undone again when an undo fails part-way, from the copy the swap kept", async () => {
    const { dir, older } = await ticketsHistory();
    const code = path.join(dir, "src", "booking", "price-seat.ts");
    await appendFile(code, "// not committed\n");
    const before = await filesOf(dir);
    await swapToVersion(dir, pricing, older);

    await chmod(code, 0o444);
    try {
      await expect(undoLastSwap(dir, pricing)).rejects.toThrow(
        /^Could not write src\/booking\/price-seat\.ts: .+\. Nothing is lost: press Undo swap again once the file is free\.$/,
      );
    } finally {
      await chmod(code, 0o644);
    }
    expect((await blockVersions(dir, pricing)).swapped).toMatchObject({ commit: older });

    await undoLastSwap(dir, pricing);
    expect(await filesOf(dir)).toEqual(before);
    expect((await blockVersions(dir, pricing)).swapped).toBeNull();
  }, 30_000);

  it("can be undone while git cannot be used, since undoing needs only the copy the swap kept", async () => {
    const { repo, dir, older } = await ticketsHistory();
    const before = await filesOf(dir);
    await swapToVersion(dir, pricing, older);
    await rename(path.join(repo, ".git"), path.join(repo, "git put away"));

    const listed = await blockVersions(dir, pricing);
    expect(listed.unavailable).not.toBeNull();
    expect(listed.swapped).toMatchObject({ commit: older });

    await undoLastSwap(dir, pricing);
    expect(await filesOf(dir)).toEqual(before);
  }, 30_000);

  // The names as the folder lists them, which a disk that ignores case does not fold.
  const refundNames = async (dir: string) =>
    (await readdir(path.join(dir, "src", "booking"))).filter((name) => name.toLowerCase() === "refund-for.ts");

  it("across a rename that changed only the capitals of a code file is refused where the disk ignores case, and made where it does not", async () => {
    const { dir, git, newer } = await ticketsHistory();
    const block = await text(dir, `${PRICING}/refund-for/block.json`);
    await git("mv", "src/booking/refund-for.ts", "src/booking/Refund-For.ts");
    await put(dir, `${PRICING}/refund-for/block.json`, block.replace("src/booking/refund-for.ts", "src/booking/Refund-For.ts"));
    await git("commit", "--quiet", "-am", "Capitalise the refund's file");
    const before = await filesOf(dir);

    if (process.platform === "win32" || process.platform === "darwin") {
      await expect(swapToVersion(dir, pricing, newer)).rejects.toThrow(
        /would change src\/booking\/(refund-for|Refund-For)\.ts, whose name differs only in capitals from src\/booking\/(Refund-For|refund-for)\.ts/,
      );
      expect(await filesOf(dir)).toEqual(before);
      expect(await there(dir, ".fragmentor")).toBe(false);
      return;
    }

    await swapToVersion(dir, pricing, newer);
    expect(await refundNames(dir)).toEqual(["refund-for.ts"]);
    await undoLastSwap(dir, pricing);
    expect(await filesOf(dir)).toEqual(before);
  }, 30_000);

  it("is refused where the disk holds a file under other capitals than git's, keeping the work in it", async () => {
    const { dir, older } = await ticketsHistory();
    // Renamed on disk only, as happens where git is told the disk ignores
    // case: git goes on calling it refund-for.ts.
    await rename(path.join(dir, "src", "booking", "refund-for.ts"), path.join(dir, "src", "booking", "Refund-For.ts"));
    await appendFile(path.join(dir, "src", "booking", "Refund-For.ts"), "// not committed\n");
    const before = await filesOf(dir);

    if (process.platform !== "win32" && process.platform !== "darwin") return;
    await expect(swapToVersion(dir, pricing, older)).rejects.toThrow(
      "would change src/booking/refund-for.ts, whose name differs only in capitals from src/booking/Refund-For.ts",
    );
    expect(await filesOf(dir)).toEqual(before);
    expect(await refundNames(dir)).toEqual(["Refund-For.ts"]);
  }, 30_000);
});

describe("a link", () => {
  it("that git tracks is never swapped, as no version can hold one", async () => {
    const { dir, git } = await ticketsHistory();
    // A link as git records it, whatever the disk it is checked out on makes of it.
    await put(dir, `${PRICING}/notes.md`, "../../../../README.md");
    const object = (await git("hash-object", "-w", "--", `${PRICING}/notes.md`)).trim();
    // The index names it from the top of the repository, which holds the project in a folder.
    const prefix = (await git("rev-parse", "--show-prefix")).trim();
    await git("update-index", "--add", "--cacheinfo", `120000,${object},${prefix}${PRICING}/notes.md`);
    await git("commit", "--quiet", "-m", "Link the notes");

    expect(await swapToVersion(dir, pricing, await head(git))).toEqual({ changed: 0 });
    expect(await there(dir, `${PRICING}/notes.md`)).toBe(true);
  }, 30_000);

  it("on the way to code a swap would change refuses the swap, and is left as it was", async () => {
    const { dir, older } = await ticketsHistory();
    // The code is kept in a folder shared with something else.
    const shared = path.join(await scratch(), "shared booking");
    const booking = path.join(dir, "src", "booking");
    await cp(booking, shared, { recursive: true });
    await rm(booking, { recursive: true });
    await symlink(shared, booking, "junction");
    const kept = await filesOf(shared);

    await expect(swapToVersion(dir, pricing, older)).rejects.toThrow(
      "Swapping Pricing would go through a link at src/booking, and Fragmentor never writes through one, so it cannot be compared or swapped.",
    );
    expect((await lstat(booking)).isSymbolicLink()).toBe(true);
    expect(await filesOf(shared)).toEqual(kept);
  }, 30_000);

  it("is never written or deleted through, even when it appears after the plan was made", async () => {
    const root = await scratch();
    const elsewhere = await scratch();
    await put(elsewhere, "kept.txt", "kept\n");
    await symlink(elsewhere, path.join(root, "linked"), "junction");

    await expect(applyPlan(root, new Map([["linked/kept.txt", null]]))).rejects.toThrow(
      "Could not remove linked/kept.txt: it is reached through a link, which a swap never follows.",
    );
    await expect(applyPlan(root, new Map([["linked/new.txt", Buffer.from("new\n")]]))).rejects.toThrow(
      "Could not write linked/new.txt: it is reached through a link, which a swap never follows.",
    );
    expect(await readdir(elsewhere)).toEqual(["kept.txt"]);
  });
});

describe("a version that cannot be swapped in", () => {
  it("is refused when Fragmentor no longer reads it", async () => {
    const { dir, git } = await ticketsHistory();
    const block = await text(dir, `${PRICING}/block.json`);
    await put(dir, `${PRICING}/block.json`, JSON.stringify({ ...JSON.parse(block), children: [] }));
    await git("commit", "--quiet", "-am", "List the parts");
    const listed = await head(git);
    await put(dir, `${PRICING}/block.json`, block);
    await git("commit", "--quiet", "-am", "Stop listing them");

    const refused = swapToVersion(dir, pricing, listed);
    await expect(refused).rejects.toThrow(
      `This version cannot be compared or swapped: Fragmentor no longer reads ${PRICING}/block.json as it was written then.`,
    );
    await expect(refused).rejects.toThrow('Remove "children".');
  }, 30_000);

  it("is refused from before the block existed", async () => {
    const { dir, git, older } = await ticketsHistory();
    await put(dir, `${PRICING}/add-fee/block.json`, JSON.stringify({ role: "component", responsibility: "Add a fee." }));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Add a fee");

    await expect(swapToVersion(dir, `${pricing}/add-fee`, older)).rejects.toThrow("Add Fee was not a block in this version.");
  }, 30_000);

  it("is refused when it would change another block's folder", async () => {
    const { dir, git } = await ticketsHistory();
    const block = await text(dir, `${PRICING}/price-seat/block.json`);
    const inside = "blocks/tickets/booking-api/find-event/seat-price.ts";
    await put(dir, `${PRICING}/price-seat/block.json`, block.replace("src/booking/price-seat.ts", inside));
    await put(dir, inside, "export async function priceSeat() {}\n");
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Price seats beside finding events");
    const then = await head(git);
    await put(dir, `${PRICING}/price-seat/block.json`, block);
    await rm(path.join(dir, inside));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Price them with pricing");

    await expect(swapToVersion(dir, pricing, then)).rejects.toThrow(
      `Swapping Pricing would change ${inside}, which is inside another block's folder, so it cannot be compared or swapped on its own.`,
    );
  }, 30_000);

  it("never writes outside the project, whatever the version pointed at", async () => {
    const { repo, dir, git } = await ticketsHistory();
    const block = await text(dir, `${PRICING}/price-seat/block.json`);
    await put(dir, `${PRICING}/price-seat/block.json`, block.replace("src/booking/price-seat.ts", "../outside.ts"));
    await put(repo, "outside.ts", "committed\n");
    await gitIn(repo)("add", "--all");
    await git("commit", "--quiet", "-m", "Point outside");
    const then = await head(git);
    await put(dir, `${PRICING}/price-seat/block.json`, block);
    await git("commit", "--quiet", "-am", "Point back inside");
    await put(repo, "outside.ts", "on disk\n");

    await swapToVersion(dir, pricing, then);
    expect(await text(dir, `${PRICING}/price-seat/block.json`)).toContain("../outside.ts");
    expect(await text(repo, "outside.ts")).toBe("on disk\n");
  }, 30_000);

  it("is refused when it is not a commit at all", async () => {
    const { dir } = await ticketsHistory();
    await expect(swapToVersion(dir, pricing, "-x")).rejects.toThrow('"-x" is not a commit.');
  }, 30_000);
});
