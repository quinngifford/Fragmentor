import type { NewProjectSettings } from "../../src/codegen/emit.js";
import type { FolderToStart } from "../ipc.js";
import { COMMANDS, firstStep, usageOf } from "../../src/codegen/commands.js";
import { el, section } from "./dom.js";
import { phraseLine } from "./notes.js";

/**
 * What the person decides before a project exists.
 *
 * It is asked as a question tree rather than a flat form, because the answers
 * are not independent: where they are starting from decides whether starting
 * with a plan is even a question. Each answer reveals the next, so nobody is
 * shown a choice that does not apply to them.
 *
 * Nobody is asked what Fragmentor's role over the code should be, because that
 * is no longer a choice anyone makes: every block says where its code is, and
 * Fragmentor writes a contract for, checks and runs whichever blocks it can.
 *
 * These are the person's decisions rather than the agent's, which is why they
 * are asked here and written into fragmentor.json before any agent starts.
 * The folder is chosen afterwards by the main process, which owns the file
 * dialog, and which reconciles these answers with what is actually in it.
 * Where the person has already picked a folder, by opening one that is not a
 * project yet, the questions are asked for that folder instead.
 */

type Start = NewProjectSettings["start"];
type Level = NewProjectSettings["granularity"];

interface Choice<T> {
  value: T;
  title: string;
  text: string;
  /** Tagged beside the title, for the answer that suits most people. */
  recommended?: boolean;
}

const STARTING_POINTS: Choice<boolean>[] = [
  {
    value: false,
    title: "Starting from scratch",
    text:
      "The folder is empty. Your agent writes the program from nothing, lays the code out wherever it belongs, and points each block at it. Fragmentor writes each block's types, checks the code against them, and lets you open a block, type in values and run it on its own.",
  },
  {
    value: true,
    title: "Working with code I already have",
    text:
      "The folder already holds a program. Your agent maps it into blocks, each pointing at the code it stands for, and keeps them true as the code changes. Nothing is rewritten or moved.",
  },
];

const STARTS: Choice<Start>[] = [
  {
    value: "plan",
    title: "Plan the architecture",
    text:
      "Your agent lays out the whole shape first as planned blocks: drawn greyed out, explained, connected as loosely as it has worked out so far, and built into nothing. You look it over and agree before any code is written.",
  },
  {
    value: "build",
    title: "Build the architecture",
    text: "Your agent defines the blocks and writes their code as it goes.",
  },
];

const LEVELS: Record<Level, string> = {
  1: "A few large blocks. Only clearly separate parts get a block of their own.",
  2: "Large blocks: 2 to 4 substantial parts at each level.",
  3: "Balanced: 3 to 5 parts at each level, each one clear job of roughly 30 to 80 lines.",
  4: "Fine: 4 to 6 smaller parts at each level, roughly 20 to 50 lines each.",
  5: "Very fine: many small single-purpose blocks of roughly 10 to 30 lines.",
};

/** Suggestions only: code in any language is drawn, whether or not it can be checked. */
const COMMON_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Java", "C#", "Rust", "Ruby", "PHP", "C++", "Kotlin", "Swift"];

function legendText(node: HTMLLegendElement, text: string, tag: string): void {
  node.replaceChildren();
  node.append(`${text} `, el("span", "field-tag", tag));
}

function legend(text: string, tag: string): HTMLLegendElement {
  const node = el("legend");
  legendText(node, text, tag);
  return node;
}

function radio(name: string, value: string): HTMLInputElement {
  const input = el("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  return input;
}

/**
 * Asks for the settings in a modal dialog. Resolves to null when the person
 * cancels. Given the folder, where the person starts from is answered already
 * from whether it holds anything, and can still be changed.
 */
export function askForProjectSettings(folder?: FolderToStart): Promise<NewProjectSettings | null> {
  return new Promise((resolve) => {
    let existingCode: boolean | null = null;
    let start: Start | null = null;
    let level: Level | null = null;
    let language = "";

    const dialog = el("dialog", "new-project");
    dialog.setAttribute("aria-labelledby", "new-project-title");
    const title = el("h2", undefined, "New project");
    title.id = "new-project-title";
    dialog.append(
      title,
      el(
        "p",
        "dialog-lede",
        folder
          ? `${folder.dir} is not a Fragmentor project yet. Answer these to start one there. Fragmentor adds its own files beside what is in it and changes none of its code.`
          : "You choose the folder last.",
      ),
    );

    /**
     * One question of the tree. Its options are rebuilt whenever the question
     * itself changes, so an answer to a question no longer being asked can
     * never survive as a selection nobody can see.
     */
    function question<T>(name: string, onPick: (value: T) => void) {
      const field = el("fieldset", "dialog-field");
      const head = el("legend");
      const options = el("div", "choices");
      field.append(head, options);

      return {
        field,
        draw(text: string, choices: Choice<T>[]) {
          legendText(head, text, "required");
          options.replaceChildren();
          for (const choice of choices) {
            const label = el("label", "choice");
            const input = radio(name, String(choice.value));
            input.addEventListener("change", () => {
              onPick(choice.value);
              update();
            });
            const body = el("span", "choice-body");
            const heading = el("span", "choice-title", choice.title);
            if (choice.recommended) heading.append(el("span", "choice-tag", "Recommended"));
            body.append(heading, el("span", "choice-text", choice.text));
            label.append(input, body);
            options.append(label);
          }
        },
      };
    }

    const startingPoint = question<boolean>("starting-point", (value) => {
      existingCode = value;
    });
    startingPoint.draw("Where are you starting from?", STARTING_POINTS);
    if (folder) {
      existingCode = folder.holdsFiles;
      const answer = startingPoint.field.querySelector<HTMLInputElement>(`input[value="${folder.holdsFiles}"]`);
      if (answer) answer.checked = true;
    }

    const firstStep = question<Start>("start", (value) => {
      start = value;
    });
    firstStep.draw("How do you want to start?", STARTS);

    const granularity = el("fieldset", "dialog-field");
    granularity.append(legend("How finely should the work be divided?", "required"));
    const levels = el("div", "levels");
    for (const value of [1, 2, 3, 4, 5] as Level[]) {
      const option = el("label", "level");
      const input = radio("granularity", String(value));
      input.addEventListener("change", () => {
        level = value;
        update();
      });
      option.append(input, el("span", undefined, String(value)));
      levels.append(option);
    }
    const scale = el("div", "level-scale");
    scale.append(el("span", undefined, "fewer, larger blocks"), el("span", undefined, "more, smaller blocks"));
    const levelText = el("p", "dialog-note");
    levelText.setAttribute("aria-live", "polite");
    granularity.append(levels, scale, levelText);

    const languages = el("fieldset", "dialog-field");
    const languageInput = el("input");
    languageInput.type = "text";
    languageInput.maxLength = 40;
    languageInput.placeholder = "Let the agent choose";
    languageInput.setAttribute("list", "project-languages");
    languageInput.addEventListener("input", () => (language = languageInput.value));
    const suggestions = el("datalist");
    suggestions.id = "project-languages";
    for (const name of COMMON_LANGUAGES) {
      const option = el("option");
      option.value = name;
      suggestions.append(option);
    }
    const languageNote = el(
      "p",
      "dialog-note",
      "Code in any language is drawn. TypeScript is the one Fragmentor also checks and runs; Python gets its types written and nothing more.",
    );
    languages.append(legend("Language", "optional"), languageInput, suggestions, languageNote);

    const actions = el("div", "dialog-actions");
    const cancel = el("button", "btn quiet", "Cancel");
    cancel.type = "button";
    const create = el("button", "btn", folder ? "Start project" : "Choose folder…");
    create.type = "button";
    actions.append(cancel, create);

    dialog.append(startingPoint.field, firstStep.field, granularity, languages, actions);

    const finish = (value: NewProjectSettings | null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    create.addEventListener("click", () => {
      const settings = answered();
      if (settings) finish(settings);
    });

    /** Everything asked so far, or null while a question that applies is unanswered. */
    function answered(): NewProjectSettings | null {
      if (existingCode === null || level === null) return null;
      const common = { granularity: level, language: language.trim() || null, existingCode };
      // Starting with a plan is only a question where there is nothing yet.
      // Code that already exists is described, never planned.
      if (existingCode) return { ...common, start: "build" };
      return start === null ? null : { ...common, start };
    }

    function update(): void {
      // Only worth asking about an architecture nobody has written yet.
      firstStep.field.hidden = existingCode !== false;

      granularity.hidden = existingCode === null;
      levelText.textContent = level ? LEVELS[level] : "Pick a level. It can be changed later in fragmentor.json.";
      languages.hidden = existingCode === null;

      create.disabled = answered() === null;
      create.title = create.disabled ? "Answer the questions above first." : "";
    }

    update();
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * The two things to do before the agent starts: open it in the project's
 * folder, and send it the one thing that follows from the answers given.
 * Shown when the project is made, and again on the empty canvas for as long
 * as the agent has not started.
 */
export function firstStepsSections(answers: { existingCode: boolean; start: Start }, dir: string): HTMLElement[] {
  const { command, phrase, happens, next } = firstStep(answers.existingCode, answers.start);

  // Each step is headed the way every section of a panel is, so the heading
  // reads louder than what it holds rather than as a caption under it.
  const open = section("1. Open your coding agent");
  open.append(phraseLine("Claude Code or Codex, in this folder:", dir, "note-phrase", "to open your coding agent in it"));

  const send = section("2. Send it this first");
  send.dataset.first = command.name;
  send.append(phraseLine("", phrase, "note-phrase first-phrase"));
  if (command.takes === "words") {
    const example = el("p", "dialog-note");
    example.append("Describe what you want where the angle brackets are, such as ", el("code", undefined, `fragmentor ${command.name} a site where people book seats for events`), ".");
    send.append(example);
  }
  send.append(el("p", "first-step-text", happens));
  if (next) send.append(phraseLine("When you agree to the plan, send", next));

  return [open, send];
}

/**
 * Said before the first steps only when the agent would not find the
 * fragmentor command, which it needs for everything it does here. Nothing is
 * installed for the person: the command is set up once, from Fragmentor's own
 * folder, as its README says.
 */
function beforeYouStart(fragmentorDir: string): HTMLElement {
  const node = section("Before you start");
  node.append(
    el("p", "first-step-text", "Your agent will not find the fragmentor command, which it needs to check its work: it is not installed on this computer yet."),
    phraseLine(`Install it once: open a terminal in ${fragmentorDir} and run`, "npm link", "note-phrase", "to install the fragmentor command"),
    el("p", "dialog-note", "Then open your coding agent in a new terminal, so that it finds the command."),
  );
  return node;
}

/**
 * What to do now that the project exists: open the agent in its folder, and
 * the one thing to send it first. The rest of the commands are listed
 * underneath, since this is when someone is looking for what they can ask
 * for, with where to find them again.
 */
export async function showFirstSteps(answers: { existingCode: boolean; start: Start }, dir: string): Promise<void> {
  // Asked before the window opens, so that nothing in it moves once it is up.
  const ready = await window.fragmentor.commandInstalled();

  const dialog = el("dialog", "new-project first-steps");
  dialog.setAttribute("aria-labelledby", "first-steps-title");
  const title = el("h2", undefined, "Your project is ready");
  title.id = "first-steps-title";
  dialog.append(title, el("p", "dialog-lede", "Your coding agent builds it, and Fragmentor draws it as it goes."));

  const later = section("Full Command List");
  const list = el("dl", "first-commands");
  for (const each of COMMANDS) {
    const row = el("div", "first-command");
    row.dataset.command = each.name;
    row.append(el("dt", undefined, usageOf(each)), el("dd", undefined, each.title));
    list.append(row);
  }
  later.append(
    list,
    el(
      "p",
      "dialog-note",
      "A command that names a block means that block and its parts. In Claude Code each is also a slash command, such as /fragmentor-review. You can always find them again with Commands, at the top right, or View › Commands.",
    ),
  );

  const actions = el("div", "dialog-actions");
  const done = el("button", "btn", "Got it");
  done.type = "button";
  actions.append(done);

  const steps = el("div", "window-sections first-steps-body");
  if (ready.ok && !ready.value.installed) steps.append(beforeYouStart(ready.value.fragmentorDir));
  steps.append(...firstStepsSections(answers, dir), later);
  dialog.append(steps, actions);
  const finish = () => {
    dialog.close();
    dialog.remove();
  };
  done.addEventListener("click", finish);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });

  document.body.append(dialog);
  dialog.showModal();
  // Focusing the last button would otherwise scroll a short window to the
  // bottom of the dialog, past the title and the first step.
  done.focus({ preventScroll: true });
}
