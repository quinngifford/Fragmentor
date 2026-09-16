import type { NewProjectSettings } from "../../src/codegen/emit.js";

/**
 * What the person decides before a project exists.
 *
 * It is asked as a question tree rather than a flat form, because the answers
 * are not independent: where they are starting from decides what Fragmentor
 * can usefully do with the code, and that in turn decides whether starting
 * with a plan is even a question. Each answer reveals the next, so nobody is
 * shown a choice that does not apply to them.
 *
 * These are the person's decisions rather than the agent's, which is why they
 * are asked here and written into fragmentor.json before any agent starts.
 * The folder is chosen afterwards by the main process, which owns the file
 * dialog, and which reconciles these answers with what is actually in it.
 */

type Mode = NewProjectSettings["mode"];
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
    text: "The folder is empty. Your agent writes the program from nothing.",
  },
  {
    value: true,
    title: "Working with code I already have",
    text: "The folder already holds a program. Your agent works from what is there.",
  },
];

/** The same decision, put the way it lands in each case. */
const MODES: Record<"scratch" | "existing", { question: string; choices: Choice<Mode>[] }> = {
  scratch: {
    question: "What should Fragmentor's role be?",
    choices: [
      {
        value: "structured",
        title: "Shape the code: blocks with strict inputs and outputs",
        text:
          "Your agent builds the program as blocks, each a function with typed inputs, typed outputs and declared effects. Fragmentor writes the code that connects them, checks every block against its contract, and lets you open any block, type in values and run it on its own. That is what keeps a growing program testable and understandable, instead of a wall of code neither of you can hold in mind.",
        recommended: true,
      },
      {
        value: "visual",
        title: "Draw the code only",
        text:
          "Your agent writes the program however it likes and keeps a diagram of it current, so you can see how it fits together. You get the picture without the constraints: Fragmentor never generates, checks or runs anything, and there is no testing.",
      },
    ],
  },
  existing: {
    question: "What do you want to do with this code?",
    choices: [
      {
        value: "structured",
        title: "Rewrite it as a structured architecture",
        text:
          "Your agent moves this program's logic into blocks with typed inputs and outputs, and deletes the old files once the blocks pass their tests. Everything then becomes checkable and separately runnable. The code is genuinely rewritten, so commit it to version control first.",
      },
      {
        value: "visual",
        title: "Draw it as it is",
        text:
          "Your agent maps the program into a diagram and keeps it current as the code changes. Nothing is rewritten, generated or run.",
      },
    ],
  },
};

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

/** The languages structured mode can generate code for, as the person should hear about them. */
const STRUCTURED_LANGUAGES = [
  { value: "", label: "Let the agent choose" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python (diagram and types only: Fragmentor cannot run Python yet)" },
];

/** Suggestions only: a visual project can draw code in any language. */
const COMMON_LANGUAGES = ["TypeScript", "JavaScript", "Python", "Go", "Java", "C#", "Rust", "Ruby", "PHP", "C++", "Kotlin", "Swift"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

/** Asks for the settings in a modal dialog. Resolves to null when the person cancels. */
export function askForProjectSettings(): Promise<NewProjectSettings | null> {
  return new Promise((resolve) => {
    let existingCode: boolean | null = null;
    let mode: Mode | null = null;
    let start: Start | null = null;
    let level: Level | null = null;
    let language = "";

    const dialog = el("dialog", "new-project");
    dialog.setAttribute("aria-labelledby", "new-project-title");
    const title = el("h2", undefined, "New project");
    title.id = "new-project-title";
    dialog.append(title, el("p", "dialog-lede", "You choose the folder last."));

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
      mode = null;
      start = null;
      language = "";
    });
    startingPoint.draw("Where are you starting from?", STARTING_POINTS);

    const role = question<Mode>("mode", (value) => {
      mode = value;
      language = "";
    });

    const firstStep = question<Start>("start", (value) => {
      start = value;
    });

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
    const languageSlot = el("div", "language-slot");
    const languageNote = el("p", "dialog-note");
    languages.append(legend("Language", "optional"), languageSlot, languageNote);

    const actions = el("div", "dialog-actions");
    const cancel = el("button", "btn quiet", "Cancel");
    cancel.type = "button";
    const create = el("button", "btn", "Choose folder…");
    create.type = "button";
    actions.append(cancel, create);

    dialog.append(startingPoint.field, role.field, firstStep.field, granularity, languages, actions);

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
      if (existingCode === null || mode === null || level === null) return null;
      const common = { mode, granularity: level, language: language.trim() || null, existingCode };
      // Starting with a plan is only a question where there is nothing yet.
      // Code that already exists is described or rebuilt, never planned.
      if (existingCode) return { ...common, start: "build" };
      return start === null ? null : { ...common, start };
    }

    let languageDrawnFor: Mode | null | undefined;
    let roleDrawnFor: boolean | null | undefined;

    function drawLanguage(): void {
      languageSlot.replaceChildren();
      if (mode === "visual") {
        const input = el("input");
        input.type = "text";
        input.maxLength = 40;
        input.placeholder = "Let the agent say";
        input.setAttribute("list", "project-languages");
        input.addEventListener("input", () => (language = input.value));
        const suggestions = el("datalist");
        suggestions.id = "project-languages";
        for (const name of COMMON_LANGUAGES) {
          const option = el("option");
          option.value = name;
          suggestions.append(option);
        }
        languageSlot.append(input, suggestions);
        languageNote.textContent = existingCode
          ? "What the existing code is written in. Code in any language can be drawn."
          : "What you would like it written in. Code in any language can be drawn.";
        return;
      }

      const select = el("select");
      for (const option of STRUCTURED_LANGUAGES) {
        const item = el("option", undefined, option.label);
        item.value = option.value;
        select.append(item);
      }
      select.addEventListener("change", () => (language = select.value));
      languageSlot.append(select);
      languageNote.textContent = "Every system in the project is written in it.";
    }

    function update(): void {
      if (roleDrawnFor !== existingCode) {
        if (existingCode !== null) {
          const asked = MODES[existingCode ? "existing" : "scratch"];
          role.draw(asked.question, asked.choices);
        }
        // Both answers below were cleared along with the role, so their
        // controls are rebuilt too. A radio left checked for an answer that
        // no longer holds cannot be chosen again: clicking the one already
        // checked raises no event, so nothing would notice.
        firstStep.draw("How do you want to start?", STARTS);
        languageDrawnFor = undefined;
        roleDrawnFor = existingCode;
      }
      role.field.hidden = existingCode === null;

      // Only worth asking about an architecture nobody has written yet.
      firstStep.field.hidden = existingCode !== false || mode === null;

      granularity.hidden = mode === null;
      levelText.textContent = level ? LEVELS[level] : "Pick a level. It can be changed later in fragmentor.json.";

      languages.hidden = mode === null;
      if (mode !== null && languageDrawnFor !== mode) {
        drawLanguage();
        languageDrawnFor = mode;
      }

      create.disabled = answered() === null;
      create.title = create.disabled ? "Answer the questions above first." : "";
    }

    update();
    document.body.append(dialog);
    dialog.showModal();
  });
}
