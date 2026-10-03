import { RULES_FILE, formatRule, refuseRule } from "../../src/model/rules.js";
import type { RuleKind } from "../../src/model/rules.js";
import type { SnapshotRule } from "../../src/project/rules.js";
import type { SnapshotBlock } from "../../src/project/snapshot.js";
import type { Result } from "../ipc.js";
import { revealBlock } from "./canvas.js";
import { el, section } from "./dom.js";
import { ui } from "./state.js";

/**
 * The person's rules over the architecture, made and removed by clicking.
 *
 * A rule is made from two blocks picked out together — "Workers must never
 * reach Client" — and from then on Fragmentor holds every change to it, in
 * the window and in the agent's `fragmentor check`. The rules live in
 * `.fragmentor/rules.json`, which the agent may change only to re-point a
 * rule at a block it moved, because a guard rail written by the party it
 * constrains guards nothing.
 *
 * What is kept here is only what the person is in the middle of: whether
 * the offers are open, the reason being typed, and which Remove is waiting
 * to be confirmed. The rules themselves arrive with the snapshot.
 */

let redrawAll: () => void = () => {};
let reloadProject: () => Promise<void> = async () => {};
export function onRulesChange(callbacks: { all: () => void; reload: () => Promise<void> }): void {
  redrawAll = callbacks.all;
  reloadProject = callbacks.reload;
}

/** Whether the two offers are on show, opened by Add a rule…. */
let adding = false;
/** Which pair the offers are about. Picking out a different pair starts afresh. */
let offersFor: string | null = null;
/** Which way round the sentence runs: false reads the blocks as they were picked. */
let swapped = false;
/** The reason being typed, kept while the agent's changes redraw the panel. */
let reason = "";
/** The rule whose Remove is waiting to be asked again, by its sentence. */
let confirming: string | null = null;
/** What the last press said went wrong, keyed by the row it was pressed on. */
const said = new Map<string, string>();
let busy = false;

/** Everything unsent is dropped with the project it belonged to. */
export function forgetRules(): void {
  adding = false;
  offersFor = null;
  swapped = false;
  reason = "";
  confirming = null;
  said.clear();
  busy = false;
}

/** Writes through the kernel, says how it went, and shows the project as it now is. */
async function write(row: string, work: (dir: string) => Promise<Result<null>>, done: string): Promise<void> {
  const dir = ui.dir;
  if (!dir || busy) return;
  busy = true;
  said.clear();
  redrawAll();
  const result = await work(dir);
  busy = false;
  if (result.ok) {
    ui.status = { text: done, tone: "good" };
  } else {
    said.set(row, result.error);
    ui.status = { text: result.error, tone: "bad" };
  }
  await reloadProject();
  redrawAll();
}

function addRule(text: string): void {
  const why = reason.trim();
  void write("add", (dir) => window.fragmentor.addRule(dir, text, why === "" ? undefined : why), "Added the rule. Fragmentor now checks it whenever anything changes.").then(
    () => {
      if (!said.has("add")) {
        adding = false;
        reason = "";
        redrawAll();
      }
    },
  );
}

/**
 * Remove, asking before it deletes: the first press turns into the question,
 * and only Remove it removes. Used under an offer that is already a rule and
 * on the project panel's list alike.
 */
function removeControls(rule: string): HTMLElement {
  const wrap = el("div", "rule-remove");
  if (confirming === rule) {
    // A question, not something wrong, so it is not dressed in red.
    wrap.append(el("span", "bench-note", "Remove this rule? Fragmentor stops checking it, for everyone once the project is committed."));
    const yes = el("button", "run-btn", "Remove it");
    yes.disabled = busy;
    yes.addEventListener("click", () => {
      confirming = null;
      void write(rule, (dir) => window.fragmentor.removeRule(dir, rule), "Removed the rule.");
    });
    const no = el("button", "btn quiet tiny", "Keep");
    no.addEventListener("click", () => {
      confirming = null;
      redrawAll();
    });
    wrap.append(yes, no);
  } else {
    const remove = el("button", "btn quiet tiny", "Remove");
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      confirming = rule;
      said.clear();
      redrawAll();
    });
    wrap.append(remove);
  }
  const trouble = said.get(rule);
  if (trouble) wrap.append(el("p", "bench-note bad", trouble));
  return wrap;
}

/** The sentence in the blocks' names, which is how the person reads it; the paths stay in the file. */
function words(kind: RuleKind, fromName: string, toName: string): string {
  return kind === "never" ? `${fromName} must never reach ${toName}` : `Only ${fromName} may reach ${toName}`;
}

/**
 * The Rules section beside two picked-out blocks: a button first, and then
 * the two rules that make sense between them, worded in their names, with
 * room for a reason. A pair no rule fits says why in one sentence.
 */
export function ruleOffers(first: SnapshotBlock, second: SnapshotBlock): HTMLElement {
  const node = section("Rules");
  node.dataset.ruleOffers = "";

  // The offers, and anything typed into them, are about one pair of blocks:
  // picking out a different pair folds back to the button.
  const pairKey = [first.path, second.path].sort().join("\u0000");
  if (offersFor !== pairKey) {
    offersFor = pairKey;
    adding = false;
    swapped = false;
    reason = "";
  }

  if (!adding) {
    const open = el("button", "btn", "Add a rule…");
    open.addEventListener("click", () => {
      adding = true;
      said.clear();
      redrawAll();
    });
    node.append(open, el("p", "bench-note", "A rule says what must never reach what. Fragmentor checks it against the diagram and the code whenever anything changes."));
    return node;
  }

  const existing = (ui.snapshot?.rules ?? []).map((rule) => rule.rule);
  const pair = (block: SnapshotBlock) => ({ path: block.path, name: block.name, role: block.role });

  // A pair no rule fits either way round says why in one sentence. When only
  // one way round could be a rule — a database picked first, say — the
  // sentence runs that way, whichever block was picked first.
  const forwardRefused = refuseRule("never", pair(first), pair(second), []);
  const backwardRefused = refuseRule("never", pair(second), pair(first), []);
  if (forwardRefused !== null && backwardRefused !== null) {
    node.append(el("p", "bench-note", forwardRefused));
    return node;
  }
  const flipped = backwardRefused !== null ? false : forwardRefused !== null ? true : swapped;
  const [from, to] = flipped ? [second, first] : [first, second];

  for (const kind of ["never", "only"] as const) {
    const rule = formatRule({ kind, from: from.path, to: to.path });
    const row = el("div", "rule-offer");
    if (existing.includes(rule)) {
      row.append(el("span", "rule-offer-made", words(kind, from.name, to.name)), el("span", "bench-note", "already a rule"));
      row.append(removeControls(rule));
    } else {
      const make = el("button", "btn quiet", busy ? "Adding…" : words(kind, from.name, to.name));
      make.disabled = busy;
      make.title = `From now on, ${words(kind, from.name, to.name).toLowerCase()}: anything else is a problem, here and in the agent's check.`;
      make.addEventListener("click", () => addRule(rule));
      row.append(make);
    }
    node.append(row);
  }

  const why = el("input", "rule-why");
  why.id = "rule-why";
  why.type = "text";
  why.maxLength = 200;
  why.placeholder = "Why? (optional, kept with the rule)";
  why.value = reason;
  why.addEventListener("input", () => {
    reason = why.value;
  });
  node.append(why);

  // Only when a rule could run either way is there anything to swap.
  if (forwardRefused === null && backwardRefused === null) {
    const swap = el("button", "btn quiet tiny", "Other way round");
    swap.title = `Offer rules about what reaches ${from.name} instead.`;
    swap.addEventListener("click", () => {
      swapped = !swapped;
      redrawAll();
    });
    node.append(swap);
  }

  const trouble = said.get("add");
  if (trouble) node.append(el("p", "bench-note bad", trouble));
  return node;
}

/** One rule on the project's panel: the sentence, its reason, and where it stands. */
function ruleRow(rule: SnapshotRule): HTMLElement {
  const row = el("div", "rule-row");
  row.dataset.rule = rule.rule;
  row.append(el("div", "rule-words", words(rule.kind, rule.fromName, rule.toName)));
  row.append(el("div", "rule-paths", rule.rule));
  if (rule.why !== null) row.append(el("div", "pdesc", rule.why));

  const state = el("div", "rule-state");
  if (rule.problem !== null) {
    state.classList.add("bad");
    state.textContent = rule.problem;
  } else if (rule.brokenBy.length > 0) {
    // A break Fragmentor guessed at is a warning, amber like any other:
    // red is kept for the breaks it is sure of.
    const say = (tone: "bad" | "warn", words: string, paths: string[]) => {
      if (paths.length === 0) return;
      const group = el("span", `rule-broke ${tone}`);
      group.append(el("span", undefined, words));
      for (const blockPath of paths) {
        const name = ui.snapshot?.blocks[blockPath]?.name ?? blockPath;
        const go = el("button", "btn quiet tiny", name);
        go.title = "Show this block";
        go.addEventListener("click", () => revealBlock(blockPath));
        group.append(go);
      }
      state.append(group);
    };
    say("bad", "broken by", rule.brokenBy.filter((blockPath) => !rule.guessed.includes(blockPath)));
    say("warn", "may be broken by", rule.guessed);
  } else {
    state.textContent = rule.declaredOnly ? "kept, from what the diagram declares" : "kept";
  }
  row.append(state);

  const actions = el("div", "rule-actions");
  if (ui.snapshot?.blocks[rule.from] && ui.snapshot.blocks[rule.to]) {
    const show = el("button", "btn quiet tiny", "Show");
    show.title = "Pick out the two blocks this rule is between.";
    show.addEventListener("click", () => {
      revealBlock(rule.from);
      ui.selection.add(rule.to);
      redrawAll();
    });
    actions.append(show);
  }
  actions.append(removeControls(rule.rule));
  row.append(actions);
  return row;
}

/**
 * Every rule, on the panel shown when nothing is picked out, or nothing at
 * all: a project without rules shows no rules chrome, and the way to make
 * one is beside two picked-out blocks, where it is about something.
 */
export function rulesSection(): HTMLElement | null {
  const rules = ui.snapshot?.rules ?? [];
  // The file may be there and unreadable, in which case no rule is being
  // checked, and showing nothing would be the panel lying.
  const unreadable = ui.snapshot?.diagnostics.some((each) => each.blockPath === RULES_FILE) ?? false;
  if (rules.length === 0 && !unreadable) return null;

  const node = section("Rules");
  node.dataset.rules = "";
  if (rules.length === 0) {
    node.append(el("p", "bench-note bad", "The rules file is not as Fragmentor writes it, so no rule is checked; the problem is listed above."));
    return node;
  }

  for (const rule of rules) node.append(ruleRow(rule));
  return node;
}
