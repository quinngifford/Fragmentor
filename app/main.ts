import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { CHANNELS } from "./ipc.js";
import type { Result, RunBlockRequest, SaveCasesRequest, SaveLayoutRequest, WriteImplRequest } from "./ipc.js";
import { projectSnapshot } from "../src/project/snapshot.js";
import type { ProjectSnapshot } from "../src/project/snapshot.js";
import { saveViewLayout } from "../src/project/layout.js";
import { blockDir, loadProject, systemOf } from "../src/project/project.js";
import { getPack } from "../src/lang/index.js";
import { emitProject } from "../src/codegen/emit.js";
import { resolveInside } from "../src/project/safePath.js";
import { runBlock, runCases } from "../src/run/run.js";
import type { CaseResult, RunOutcome } from "../src/run/run.js";
import { saveCases } from "../src/run/cases.js";
import type { EmitResult } from "../src/codegen/emit.js";

/**
 * The main process owns everything with side effects: the window, the disk,
 * and the kernel. The renderer is given data and sends back requests.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const RECENT_LIMIT = 8;

/** Started to check itself rather than to be used. */
function selfChecking(): boolean {
  return Boolean(process.env.FRAGMENTOR_SMOKE) || process.argv.includes("--smoke");
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failed(error: unknown): Result<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function recentFile(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

async function readRecent(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(recentFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

async function rememberProject(dir: string): Promise<void> {
  const recent = await readRecent();
  const next = [dir, ...recent.filter((entry) => entry !== dir)].slice(0, RECENT_LIMIT);
  await mkdir(path.dirname(recentFile()), { recursive: true });
  await writeFile(recentFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function openProject(dir: string): Promise<ProjectSnapshot> {
  const snapshot = await projectSnapshot(dir);
  await rememberProject(snapshot.dir);
  return snapshot;
}

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.chooseProject, async (): Promise<Result<ProjectSnapshot | null>> => {
    try {
      const window = BrowserWindow.getFocusedWindow();
      const picked = window
        ? await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "Open a Fragmentor project" })
        : await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open a Fragmentor project" });

      const dir = picked.canceled ? undefined : picked.filePaths[0];
      if (!dir) return ok(null);
      return ok(await openProject(dir));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.loadProject, async (_event, dir: string): Promise<Result<ProjectSnapshot>> => {
    try {
      return ok(await openProject(dir));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.recentProjects, async (): Promise<Result<string[]>> => {
    try {
      return ok(await readRecent());
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.exampleProjects, async (): Promise<Result<{ dir: string; name: string }[]>> => {
    try {
      const examples = [
        { dir: path.join(repoRoot, "examples", "job-ranker"), name: "Job Relevance Ranker" },
        { dir: path.join(repoRoot, "examples", "contract-generator"), name: "Contract Generator" },
      ];
      const present: { dir: string; name: string }[] = [];
      for (const example of examples) {
        try {
          await loadProject(example.dir);
          present.push(example);
        } catch {
          // An example that will not load is simply not offered.
        }
      }
      return ok(present);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.writeImpl, async (_event, request: WriteImplRequest): Promise<Result<null>> => {
    try {
      // The file name depends on the language of the system this block is in,
      // and the renderer is not trusted to say which file to write.
      const project = await loadProject(request.dir);
      const system = systemOf(project, request.blockPath);
      if (!system) throw new Error(`"${request.blockPath}" is not part of any system in this project.`);

      const target = resolveInside(blockDir(request.dir, request.blockPath), getPack(system.language).implFile);
      await writeFile(target, request.contents, "utf8");
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.saveLayout, async (_event, request: SaveLayoutRequest): Promise<Result<null>> => {
    try {
      resolveInside(request.dir, "layout.json");
      await saveViewLayout(request.dir, request.viewPath, request.positions);
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.emitCode, async (_event, dir: string): Promise<Result<EmitResult>> => {
    try {
      return ok(await emitProject(await loadProject(dir)));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.runBlock, async (_event, request: RunBlockRequest): Promise<Result<RunOutcome>> => {
    try {
      return ok(await runBlock({ projectDir: request.dir, blockPath: request.blockPath, input: request.input }));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.saveCases, async (_event, request: SaveCasesRequest): Promise<Result<null>> => {
    try {
      resolveInside(blockDir(request.dir, request.blockPath), "cases.json");
      await saveCases(request.dir, request.blockPath, request.cases);
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.runCases, async (_event, dir: string, blockPath: string): Promise<Result<CaseResult[]>> => {
    try {
      return ok(await runCases(dir, blockPath));
    } catch (error) {
      return failed(error);
    }
  });

  ipcMain.handle(CHANNELS.revealBlock, async (_event, dir: string, blockPath: string): Promise<Result<null>> => {
    try {
      shell.showItemInFolder(resolveInside(blockDir(dir, blockPath), "block.json"));
      return ok(null);
    } catch (error) {
      return failed(error);
    }
  });
}

/**
 * A scripted run of the real interface: open the window, click through to an
 * example project, report what was drawn, and quit. Started with
 * FRAGMENTOR_SMOKE=1, it is how this application gets checked without a person
 * watching it.
 */
function smokeScript(exampleDir: string): string {
  return `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(400);

    const boot = document.querySelector(".canvas-empty");
    const links = [...document.querySelectorAll(".welcome-link")].map((b) => b.textContent);
    const target = [...document.querySelectorAll(".welcome-link")]
      .find((b) => b.title === ${JSON.stringify(exampleDir)} || /Job Relevance Ranker/.test(b.textContent));

    if (!target) return { stage: "welcome", bootError: boot ? boot.textContent : null, links };
    target.click();
    await wait(900);

    const drawn = {
      projectOpen: document.body.dataset.project === "open",
      blocks: document.querySelectorAll(".block-box").length,
      buses: document.querySelectorAll(".bus-group").length,
      brackets: document.querySelectorAll(".group-bracket").length,
      treeItems: document.querySelectorAll(".tree .node").length,
      zoom: (document.getElementById("zoom-level") || {}).textContent,
      inspector: (document.querySelector("#inspector h2") || {}).textContent || null,
    };

    // Editing a block's code and having it reach the disk is the whole point
    // of this being an application rather than a drawing, so check it.
    const editor = () => document.querySelector(".code-editor");
    const saveButton = () => document.querySelector(".code-foot .btn");
    const statusText = () => (document.getElementById("status") || {}).textContent || "";

    const leaf = [...document.querySelectorAll(".tree .node")]
      .find((node) => node.textContent.includes("load-postings"));
    if (!leaf) return { stage: "no-leaf", drawn };
    leaf.click();
    await wait(300);

    const first = editor();
    if (!first) return { stage: "no-editor", drawn };
    const original = first.value;

    const type = (value) => {
      const box = editor();
      box.value = value;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    };

    type(original + "// written by the self-check\\n");
    saveButton().click();
    await wait(500);
    const afterSave = statusText();

    type(original);
    saveButton().click();
    await wait(500);
    // Measured here, before anything navigates away and swaps the editor out.
    const restoredCleanly = editor().value === original && /Saved .*impl\\.ts/.test(statusText());

    // Running a block is what makes this an application rather than a viewer.
    const rankJobs = [...document.querySelectorAll(".tree .node")]
      .find((node) => node.textContent.includes("rank-jobs"));

    let ran = "no rank-jobs in the tree";
    if (rankJobs) {
      rankJobs.click();
      await wait(400);

      const skills = document.querySelector(".bench textarea");
      if (skills) {
        skills.value = JSON.stringify(["TypeScript", "testing"]);
        skills.dispatchEvent(new Event("input", { bubbles: true }));
      }

      const runButton = [...document.querySelectorAll(".bench .btn")]
        .find((button) => button.textContent === "Run block");

      if (!runButton) ran = "no run button";
      else if (runButton.disabled) ran = "run button disabled";
      else {
        runButton.click();
        await wait(8000);
        const output = document.querySelector(".run-result pre.code");
        const problems = document.querySelector(".run-problems li");
        ran = output ? output.textContent.slice(0, 200) : problems ? "PROBLEM: " + problems.textContent : "no result";
      }
    }

    // Each of these is reported rather than allowed to abort the whole check.
    const attempt = async (run) => {
      try {
        return await run();
      } catch (error) {
        return "THREW: " + (error && error.message ? error.message : String(error));
      }
    };

    const nodeOf = (key) => document.querySelector('.block-box[data-key="' + key + '"]');

    const tests = await attempt(async () => {
      const runAll = [...document.querySelectorAll(".section .btn")]
        .find((button) => button.textContent === "Run all tests");
      if (!runAll) return "no run-all button";
      if (runAll.disabled) return "run-all disabled";
      runAll.click();
      await wait(9000);
      const summary = document.querySelector(".case-summary");
      return summary ? summary.textContent : "no summary";
    });

    const dragged = await attempt(async () => {
      const target = nodeOf("load-postings");
      if (!target) return "no block to drag";
      const before = target.getAttribute("transform");
      const at = (type, x, y) =>
        new PointerEvent(type, { bubbles: true, pointerId: 7, clientX: x, clientY: y, isPrimary: true });
      target.dispatchEvent(at("pointerdown", 400, 400));
      window.dispatchEvent(at("pointermove", 480, 460));
      window.dispatchEvent(at("pointerup", 480, 460));
      await wait(400);
      const moved = before !== target.getAttribute("transform");

      // Drag it back, so running this check leaves the example unchanged.
      target.dispatchEvent(at("pointerdown", 480, 460));
      window.dispatchEvent(at("pointermove", 400, 400));
      window.dispatchEvent(at("pointerup", 400, 400));
      await wait(400);

      const restored = before === target.getAttribute("transform");
      return moved ? (restored ? "moved" : "moved but not restored") : "DID NOT MOVE";
    });

    const openedByDoubleClick = await attempt(async () => {
      const composite = nodeOf("score-posting");
      if (!composite) return "no composite to open";
      composite.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await wait(700);
      const crumb = document.querySelector('.crumb[aria-current="true"]');
      return crumb ? crumb.textContent : "no current crumb";
    });

    // Finish on a block that has saved tests, scrolled to them, so the
    // screenshot this check captures shows the part worth looking at.
    const shown = await attempt(async () => {
      const withTests = [...document.querySelectorAll(".tree .node")]
        .find((node) => node.textContent.includes("extract-profile-keywords"));
      if (!withTests) return "not found";
      withTests.click();
      await wait(400);

      const runAll = [...document.querySelectorAll(".section .btn")]
        .find((button) => button.textContent === "Run all tests");
      if (runAll && !runAll.disabled) {
        runAll.click();
        await wait(6000);
      }

      // Re-select after the run, since finishing redraws the panels, then
      // scroll so the captured screenshot shows the tests.
      [...document.querySelectorAll(".tree .node")]
        .find((node) => node.textContent.includes("extract-profile-keywords"))
        .click();
      await wait(400);

      const panel = document.getElementById("inspector-pane");
      panel.scrollTop = panel.scrollHeight;
      await wait(400);

      const heading = document.querySelector("#inspector h2");
      const summary = document.querySelector(".case-summary");
      return (heading ? heading.textContent : "no heading") + " / " + (summary ? summary.textContent : "no summary");
    });

    return {
      stage: "opened",
      bootError: (document.querySelector(".canvas-empty") || {}).textContent || null,
      ...drawn,
      ran,
      tests,
      dragged,
      openedByDoubleClick,
      shown,
      savedToDisk: /Saved .*impl\\.ts/.test(afterSave),
      saveMessage: afterSave.slice(-70),
      restoredCleanly,
      status: statusText().slice(0, 90),
    };
  })()`;
}

function attachSmokeCheck(window: BrowserWindow): void {
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`The window failed to load: ${description} (${code})`);
    process.exitCode = 1;
    app.quit();
  });

  window.webContents.once("did-finish-load", () => {
    void (async () => {
      try {
        const report: unknown = await window.webContents.executeJavaScript(
          smokeScript(path.join(repoRoot, "examples", "job-ranker")),
        );
        console.log(JSON.stringify(report, null, 2));

        // The window needs a moment to composite what the script just did,
        // or the capture shows a frame from before it.
        window.webContents.invalidate();
        await new Promise((resolve) => setTimeout(resolve, 900));

        const shot = path.join(repoRoot, "dist", "self-check.png");
        await writeFile(shot, (await window.webContents.capturePage()).toPNG());
        console.log(`Screenshot: ${shot}`);

        const summary = report as { stage?: string; bootError?: string | null; blocks?: number };
        if (summary.stage !== "opened" || summary.bootError || !summary.blocks) process.exitCode = 1;
      } catch (error) {
        console.error("The self-check could not run:", error);
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    })();
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: "#07090a",
    title: "Fragmentor",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A window that is not in front gets its painting throttled, which makes
      // the self-check capture a frame from several steps ago.
      backgroundThrottling: !selfChecking(),
    },
  });

  if (selfChecking()) {
    // Shown but not focused: the page has to be composited to be captured,
    // and taking focus from whoever started the check would be rude.
    window.once("ready-to-show", () => window.showInactive());
    attachSmokeCheck(window);
  } else {
    window.once("ready-to-show", () => window.show());
  }

  void window.loadFile(path.join(here, "renderer", "index.html"));

  // Nothing in this application should navigate away or open a browser window.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

void app.whenReady().then(() => {
  registerHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
