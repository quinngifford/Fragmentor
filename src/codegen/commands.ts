/**
 * What the person can tell their coding agent to do, in so many words.
 *
 * Fragmentor never calls a model, so the person sets the agent going by
 * typing to it. These are the few things worth a fixed phrase, each starting
 * with `fragmentor` so it cannot be mistaken for anything else said to the
 * agent. None is also a command of the `fragmentor` program, which the agent
 * would run instead, except `notes`, which the agent is meant to run just as
 * it was said. The application lists them for the person to copy; the guide tells
 * the agent what each means; and in Claude Code each is a slash command of its
 * own. All three are made from this one list, so they never disagree.
 *
 * Nothing here may import anything: the application's window reads it as it is.
 */

export interface AgentCommand {
  /** The word after `fragmentor`, and the slash command's name after `fragmentor-`. */
  name: string;
  /** What it takes after the word: a block, meaning that block and its parts, or words of the person's own. */
  takes: "block" | "words";
  /** Whether what it takes may be left out, which for a block means the whole diagram. */
  optional: boolean;
  /** What the person reads it as, in a few words. */
  title: string;
  /** What it does, in a sentence the person reads before sending it. */
  summary: string;
  /** What the agent does when it is sent, in the guide's own voice. */
  steps: string;
}

export const COMMANDS: readonly AgentCommand[] = [
  {
    name: "notes",
    takes: "block",
    optional: true,
    title: "Work through the notes",
    summary:
      "Works through every note and flag waiting for your agent, or only those on one block and its parts, and answers each one on its note.",
    steps:
      "Run `fragmentor notes`, or `fragmentor notes <block-path>`, and work through what it lists, as the **Notes** section of FRAGMENTOR.md says.",
  },
  {
    name: "review",
    takes: "block",
    optional: true,
    title: "Check the diagram",
    summary:
      "Looks the diagram over against the code, or one block and its parts, and leaves a note on each block that needs adjusting. It changes nothing.",
    steps:
      "Run `fragmentor check`, then read each block in scope beside its code. Does its responsibility say what the code does? Is it inside what owns it, and a shared part beside what uses it? Is it the right size for the granularity, or should it be split or merged? Does `code` point at the right function, and do `access`, `capabilities` and `exposes` say what the code really reaches? Do the executions through it still match the code? Is a planned block in fact built? Leave a note with `fragmentor note` on each block that needs changing, saying what you would change and why, and change nothing. Finish with a few lines in the chat: how many notes you left, and whether the rest looks right. The notes the person answers come back to you through `fragmentor notes`.",
  },
  {
    name: "rebuild",
    takes: "block",
    optional: true,
    title: "Redraw from the code",
    summary:
      "Brings the diagram, or one block and its parts, back in line with the code as it is now, and draws it from the code where there is none yet. It changes the blocks, and none of your code.",
    steps:
      "Read the code behind every block in scope as it is now — with no diagram yet, the whole codebase — and rewrite the blocks to match: responsibilities, parts, code pointers, ports, access, capabilities and exposed entries, adding blocks for code that has none and taking away blocks whose code is gone. Bring the executions through them up to date. Change no code: where it looks wrong, leave a note. Keep what the person wrote, and planned blocks, unless the code shows them wrong, and move a block's notes with it when it moves. Run `fragmentor check` and `fragmentor test`, then commit once, with only Fragmentor's files: `fragmentor.json`, `FRAGMENTOR.md`, `blocks/`, `executions/`, `.fragmentor/`, `.claude/skills/`, and any `CLAUDE.md` or `AGENTS.md` that `fragmentor init` created. Say in the chat what changed.",
  },
  {
    name: "explain",
    takes: "words",
    optional: false,
    title: "Explain something",
    summary: "Explains a block, or answers a question about the system, in detail, in the chat. It changes nothing.",
    steps:
      "Answer in the chat, for someone who has not read the code: what it is for, how it works step by step and which functions do each part, what it reads and writes, which executions pass through it, and anything surprising. Name blocks as the diagram names them. Change nothing.",
  },
  {
    name: "plan",
    takes: "words",
    optional: false,
    title: "Plan a change",
    summary: "Draws what you describe as planned blocks, greyed out on the diagram, for you to look over before anything is built.",
    steps:
      "Work out where what the person describes belongs, and add it as blocks with `\"planned\": true`: what each is responsible for, where it sits, and the connections worked out so far. Change the blocks already there only to show where the new ones join them, and write no code. Run `fragmentor check` and commit the plan, then say in the chat what you drew and anything that is the person's to decide, and wait: `fragmentor build` is how they ask you to build it.",
  },
  {
    name: "build",
    takes: "block",
    optional: true,
    title: "Build planned blocks",
    summary: "Builds the planned blocks, or one and its parts, with their code, tests and executions, one block at a time.",
    steps:
      "Build every planned block in scope, the deepest first: take `planned` off it and off every block holding it, give it real types, write its code, its tests and the executions it starts, run `fragmentor check` and `fragmentor test` until they pass, and commit each block as it passes. Leave a note on any block where the plan turned out to be wrong.",
  },
  {
    name: "make",
    takes: "words",
    optional: false,
    title: "Make something new",
    summary:
      "Designs and builds what you describe straight away: its blocks, their code, tests and executions, with no plan to agree first.",
    steps:
      "Work out where what the person describes belongs, and build it straight away rather than drawing it as a plan to be agreed first, whichever way this project began: `fragmentor plan` is how they ask for a plan. Add its blocks, and for each write its code, its tests and the executions it starts, run `fragmentor check` and `fragmentor test` until they pass, and commit it as it passes. Change the blocks and code already there only as far as the new ones need. Say in the chat what you built.",
  },
  {
    name: "cover",
    takes: "block",
    optional: true,
    title: "Cover with tests",
    summary:
      "Adds the saved tests and executions a block is missing, or every block is. It changes no code: each bug they find is left as a note on its block.",
    steps:
      "For each block in scope, add saved tests for the cases that matter, with their values pinned: ordinary ones, the edges, and what should be turned away. Add an execution for anything that sets it going and has none. Run `fragmentor test`, and keep only what passes. Change no code: where a test shows a bug, do not keep it with the saved tests, and leave a note on the block with `fragmentor note` saying what fails, with its input, what it should give and what it gives. Commit, and say in the chat what you added and what you found.",
  },
];

/** The words to type, naming a block or words where given one. */
export function phraseFor(command: AgentCommand, target?: string): string {
  return target ? `fragmentor ${command.name} ${target}` : `fragmentor ${command.name}`;
}

/** How the command is written in a list: `fragmentor review [block]`, `fragmentor explain <what>`. */
export function usageOf(command: AgentCommand): string {
  const what = command.takes === "block" ? "block" : "what";
  return `fragmentor ${command.name} ${command.optional ? `[${what}]` : `<${what}>`}`;
}

const named = (name: string) => COMMANDS.find((command) => command.name === name)!;

/** The command that works through the notes, which the application offers wherever notes are waiting. */
export const NOTES_COMMAND = named("notes");

/**
 * What a new project's person sends their agent first, which follows from the
 * two answers they gave when they created it: code that is already there is
 * drawn from, and a program not written yet is either planned or made.
 * `phrase` is the words to send, with what they want built left for them to
 * fill in; `happens` says what the agent does with it; `next` is what to send
 * once a plan is agreed, where there is one to agree.
 */
export function firstStep(
  existingCode: boolean,
  start: "plan" | "build",
): { command: AgentCommand; phrase: string; happens: string; next: string | null } {
  if (existingCode) {
    const rebuild = named("rebuild");
    return {
      command: rebuild,
      phrase: phraseFor(rebuild),
      happens: "It reads your code and draws it as blocks, each pointing at the code it stands for, without changing any of the code.",
      next: null,
    };
  }
  if (start === "plan") {
    const plan = named("plan");
    return {
      command: plan,
      phrase: phraseFor(plan, "<what you want to build>"),
      happens: "It draws the whole architecture as planned blocks, greyed out, for you to look over before any code is written.",
      next: phraseFor(named("build")),
    };
  }
  const make = named("make");
  return {
    command: make,
    phrase: phraseFor(make, "<what you want to build>"),
    happens: "It designs the blocks and writes their code straight away, without stopping for you to agree to a plan.",
    next: null,
  };
}
