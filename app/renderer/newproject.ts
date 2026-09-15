import type { NewProjectSettings } from "../../src/codegen/emit.js";

/**
 * What the person decides before a project exists: what Fragmentor does with
 * the code, how finely it is divided, and if they like, the language. These
 * are the person's decisions rather than the agent's, which is why they are
 * asked here and written into fragmentor.json before any agent starts. The
 * folder is chosen afterwards by the main process, which owns the file dialog.
 */

type Mode = NewProjectSettings["mode"];
type Level = NewProjectSettings["granularity"];

const MODES: { mode: Mode; title: string; text: string }[] = [
  {
    mode: "structured",
    title: "Structured: Fragmentor shapes the code",
    text: "Your agent builds the program as blocks, or rebuilds the code already in the folder that way. Fragmentor writes the code between blocks, checks everything, and runs the tests.",
  },
  {
    mode: "visual",
    title: "Visual: Fragmentor only draws",
    text: "Your agent maps the code already in the folder into a diagram. The code is never changed, and there is no testing.",
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

function legend(text: string, tag: string): HTMLLegendElement {
  const node = el("legend");
  node.append(`${text} `, el("span", "field-tag", tag));
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
    let mode: Mode | null = null;
    let level: Level | null = null;
    let language = "";

    const dialog = el("dialog", "new-project");
    dialog.setAttribute("aria-labelledby", "new-project-title");
    const title = el("h2", undefined, "New project");
    title.id = "new-project-title";
    dialog.append(title, el("p", "dialog-lede", "You choose the folder next. It can be empty, or already hold code."));

    const modes = el("fieldset", "dialog-field");
    modes.append(legend("What should Fragmentor do with the code?", "required"));
    for (const option of MODES) {
      const choice = el("label", "choice");
      const input = radio("mode", option.mode);
      input.addEventListener("change", () => {
        mode = option.mode;
        language = "";
        update();
      });
      const body = el("span", "choice-body");
      body.append(el("span", "choice-title", option.title), el("span", "choice-text", option.text));
      choice.append(input, body);
      modes.append(choice);
    }

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

    dialog.append(modes, granularity, languages, actions);

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
      if (mode && level) finish({ mode, granularity: level, language: language.trim() || null });
    });

    let languageDrawnFor: Mode | null | undefined;

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
        languageNote.textContent = "What the existing code is written in. Code in any language can be drawn.";
        return;
      }

      const select = el("select");
      select.disabled = mode === null;
      for (const option of STRUCTURED_LANGUAGES) {
        const item = el("option", undefined, option.label);
        item.value = option.value;
        select.append(item);
      }
      select.addEventListener("change", () => (language = select.value));
      languageSlot.append(select);
      languageNote.textContent = mode === null ? "Choose what Fragmentor does with the code first." : "Every system in the project is written in it.";
    }

    function update(): void {
      levelText.textContent = level ? LEVELS[level] : "Pick a level. It can be changed later in fragmentor.json.";
      if (languageDrawnFor !== mode) {
        drawLanguage();
        languageDrawnFor = mode;
      }
      create.disabled = !mode || !level;
      create.title = create.disabled ? "Choose what Fragmentor does with the code, and a level, first." : "";
    }

    update();
    document.body.append(dialog);
    dialog.showModal();
  });
}
