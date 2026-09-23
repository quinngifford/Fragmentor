import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { emitProject } from "../codegen/emit.js";
import { loadProject } from "./project.js";

const execFileAsync = promisify(execFile);

/**
 * Git in one folder, as whoever builds a history to test against: given a
 * name, because a machine that has never committed has none to commit under,
 * and never asked to sign. It gives back what git printed.
 */
export function gitIn(dir: string): (...args: string[]) => Promise<string> {
  return async (...args) =>
    (
      await execFileAsync(
        "git",
        ["-C", dir, "-c", "user.name=Fragmentor", "-c", "user.email=check@fragmentor.invalid", "-c", "commit.gpgsign=false", ...args],
        { maxBuffer: 64 << 20, windowsHide: true },
      )
    ).stdout;
}

/**
 * Every file in a folder, by its path from there, with its bytes as base64:
 * enough to tell whether any byte of any of them changed. Git's own folder and
 * the copies kept for Undo swap are not the project's files.
 */
export async function filesOf(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (/^\.(git|fragmentor)\//.test(file)) continue;
    found.set(file, (await readFile(path.join(dir, file))).toString("base64"));
  }
  return found;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Two versions of examples/tickets' pricing, committed in `projectDir`, which must already be inside a
 *  git repository with nothing else staged. The older has a part of its own taking a fifth off from the
 *  third seat; the newer is the example as it ships. Used by history tests and the application's self-check. */
export async function commitExampleHistory(projectDir: string): Promise<{ older: string; newer: string }> {
  const git = gitIn(projectDir);
  const code = path.join(projectDir, "src", "booking");
  const pricing = path.join(projectDir, "blocks", "tickets", "booking-api", "pricing");
  const priceSeat = path.join(pricing, "price-seat");
  const discount = path.join(pricing, "seat-discount");

  const shipped = new Map<string, Buffer>();
  for (const file of [path.join(code, "price-seat.ts"), ...["block.json", "cases.json", "contract.ts"].map((name) => path.join(priceSeat, name))]) {
    shipped.set(file, await readFile(file));
  }
  const asShipped = async () => {
    for (const [file, bytes] of shipped) await writeFile(file, bytes);
    await rm(discount, { recursive: true, force: true });
    await rm(path.join(code, "seat-discount.ts"), { force: true });
  };

  let older: string;
  try {
    // The older version: a part of its own takes a fifth off from the third seat.
    await writeFile(
      path.join(code, "price-seat.ts"),
      `import type { PriceSeatInput, PriceSeatOutput, PriceSeatCaps } from "../../blocks/tickets/booking-api/pricing/price-seat/contract.js";
import { seatDiscount } from "./seat-discount.js";

export async function priceSeat(input: PriceSeatInput, caps: PriceSeatCaps): Promise<PriceSeatOutput> {
  const { discount } = await seatDiscount({ seat: input.seat }, caps);
  return { price: input.fullPrice * (1 - discount) };
}
`,
    );
    await writeFile(
      path.join(priceSeat, "block.json"),
      json({
        responsibility: "Price one seat of a booking, less whatever that seat is discounted.",
        code: "src/booking/price-seat.ts#priceSeat",
        inputs: { fullPrice: "number", seat: "number" },
        outputs: { price: "number" },
      }),
    );
    await writeFile(
      path.join(priceSeat, "cases.json"),
      json([
        { name: "the first two seats are full price", input: { fullPrice: 25, seat: 2 }, expected: { price: 25 } },
        { name: "the third is a fifth off", input: { fullPrice: 25, seat: 3 }, expected: { price: 20 } },
      ]),
    );
    await mkdir(discount, { recursive: true });
    await writeFile(
      path.join(discount, "block.json"),
      json({
        responsibility: "Say how much of one seat's price is taken off: a fifth, from the third seat.",
        code: "src/booking/seat-discount.ts#seatDiscount",
        inputs: { seat: "number" },
        outputs: { discount: "number" },
      }),
    );
    await writeFile(
      path.join(discount, "cases.json"),
      json([{ name: "the third seat is a fifth off", input: { seat: 3 }, expected: { discount: 0.2 } }]),
    );
    await writeFile(
      path.join(code, "seat-discount.ts"),
      `import type { SeatDiscountInput, SeatDiscountOutput, SeatDiscountCaps } from "../../blocks/tickets/booking-api/pricing/seat-discount/contract.js";

export async function seatDiscount(input: SeatDiscountInput, caps: SeatDiscountCaps): Promise<SeatDiscountOutput> {
  return { discount: input.seat >= 3 ? 0.2 : 0 };
}
`,
    );

    // Its contracts too, as the agent's own check would have written them before committing.
    await emitProject(await loadProject(projectDir));
    await git("add", "--all", "--", ".");
    await git("commit", "--quiet", "-m", "Price seats with a discount from the third seat");
    older = (await git("rev-parse", "HEAD")).trim();
  } catch (error) {
    // Put the example back as it ships, so whatever runs on it next is not
    // judged against half of an older version that was never committed.
    await asShipped();
    throw error;
  }

  // And the example as it ships, which is the newer version.
  await asShipped();
  await git("add", "--all", "--", ".");
  await git("commit", "--quiet", "-m", "Take ten percent off from the fifth seat");
  return { older, newer: (await git("rev-parse", "HEAD")).trim() };
}
