# Real runs: plan

## What the person asked for
The person wants to keep executions that really happened in their own application, eventually ones customers caused in production, and step through them in Fragmentor to see exactly what happened. Later, Fragmentor should light up as runs happen. They want this without a database server, and without Fragmentor running drawn code itself, which they decided against on 2026-10-06 (STATUS.md:8). They accepted this order: their own app run locally first, then keeping chosen runs, then the team's tracing system, then a live view.

## What it will do
- **Phase 1a (agent and terminal).** Fragmentor writes a small tracking file into the project's private `.fragmentor/` folder. The person pastes one line into a terminal and starts their TypeScript app there with tsx, as usual. Each thing the app does becomes one run, saved on this computer only. A run records which block called which, what each call was given and gave back, with passwords, tokens and sessions hidden, and how long each call took. `fragmentor runs` lists the runs and prints any one of them. This works on drawn code: Messenger's code is seen running for the first time.
- **Phase 1b.** The same for apps built to JavaScript first and for plain CommonJS JavaScript.
- **Phase 2 (window).** **File › Open a Run of Your App…** lists the runs, newest first, for example "Send Button · 14:02:11 · 41 ms". A run whose error reached the top is marked "ended with an error" in red. Clicking a run puts it on the execution bar under one chip, **From your app**, and it steps on the tree and as a Flow. Every answer shows its time.
- **Phase 3.** **Keep** on an open run, so it is never cleared away with older ones.
- **Phase 4 (only if Decision 2 is yes).** Open a trace file from the team's tracing system on the blocks.
- **Phase 5 (only if Decision 3 is yes).** Each new run of the app plays on the bar as it arrives.

## Approach
1. **Format: (i), Fragmentor's own JSON. (iii), a converter from OpenTelemetry, comes in Phase 4. (ii) is rejected.**
   - A run file has two lines. Line 1 is a summary: id, start, total time, first block, call count, the error if the first call threw, the program (`process.argv[1]`'s name), and `cut`. Line 2 holds the events.
   - The events are the harness's `call`/`return`/`throw` with parent ids (recorded.ts:24-37). Each call also carries its pointer and its block path at capture time. Each answer carries `took`.
   - The list reads line 1 only, so listing never parses whole runs.
   - `capturedRun` calls `recordedTrace` (recorded.ts:98) with `{stores: {}}`, sets `source: "captured"` and drops `state`. Record's call sites stay as they are, and a run never claims to know what the stores held (recorded.ts:180-184).
   - (ii) is rejected because it adds packages to the person's build, which contracts were designed never to do (STATUS.md:30). Its ESM support is experimental, and stock spans do not see the app's own functions.
2. **The tracker inserts a line as each file loads; it does not replace exports.**
   - Export replacement (harness.cjs:312-324) fails on ES modules, which the guide uses for new empty TypeScript projects (guide.ts:537). It also misses calls within one file (recorded.ts:238-256).
   - For each function declaration a block points at, the tracker adds `try{f=__fragmentorTrack("file#f",f)}catch{}` on line 1, after any `"use strict"`. Declarations are hoisted, so importers, same-file calls and references taken while the file loads all get the wrapper. `subscribe(deliverNotification)` is one such reference (examples/messenger/src/workers/delivery.ts:16).
   - ES modules go through `module.register`, which Node 22.12 has; `registerHooks` does not exist there (F1-recorded-traces.md:146). CommonJS goes through `Module.prototype._compile` in Phase 1b.
   - Methods (`Class.method`) and `const` functions are listed as not followed. Neither example has one, and the kernel already treats methods as drawn only (src/project/code.ts:146-149).
3. **The wrapper changes nothing the app can notice.**
   - The harness's `traced` makes every call async (harness.cjs:275-299). The tracker instead keeps synchronous code synchronous, forwards `this` and every argument, and keeps `name` and `length`.
   - Values are copied as plain data only: own data properties, arrays, primitives, and Dates as their time. No getter or `toJSON` is ever called.
   - Arguments are named by the block's `inputs`, in order, even when the counts differ. Extra arguments go under `more`. A single return value is named by `outputs` when that has one key.
   - Any key at any depth whose name contains password, passwd, secret, token, session, cookie, authorization, apikey, api_key, jwt, card or cvv becomes "(hidden)". So does a named argument or output with such a name: `logIn(email, password)` and its `sessionId` (log-in/block.json).
   - A call's `took` leaves out the tracker's own copying, both inside the call and inside every call it made.
4. **Run boundaries.**
   - AsyncLocalStorage says which call made which (harness.cjs:190).
   - Its context leaks: a request handler sees the call that started the server, and a timer sees the call that set it (critic's `plans/spikes/real-runs/critic/als.mjs`, rerun today).
   - So a call joins its caller's run only while that run's first call is still open. Otherwise it starts a new run.
   - A run is written when its first call settles, then once more if calls still open at that point settle later.
   - Caps: 2000 calls per run (the counter is reset for each run, unlike harness.cjs:193), at most 10 KB per value, and 1 MB per run. Beyond them a run is marked `cut`.
   - Open runs are flushed with a synchronous write on `exit` and in `uncaughtExceptionMonitor`, so a crash is kept and still crashes.
5. **Runs stay out of the snapshot.**
   - Runs are files in `.fragmentor/runs/`, named `20261006-140211-123-<pid>-<n>.json`, with no colons. The name is the run's id in both the window and the CLI.
   - The watcher already ignores that folder (main.ts:277, history.ts:132). Git ignores it once `ignoreAllButShared` (history.ts:1194) has run, and `writeTracker` runs it first.
   - The tracker also writes `runs/.gitignore` holding `*`, because the runs are customer data and must stay ignored even if someone edits `.fragmentor/.gitignore`.
   - Nothing new enters the snapshot, so `snapshotFields.ts` needs no entry. The export drops any id that is not a written execution (app/exportPage.ts:289-290).
6. **A run is its own thing.**
   - `TraceSource` gains `"captured"` (trace.ts:145).
   - A run is never compared with a written execution (`checkRecording` compares payloads, which would turn a customer's data falsely red). It is never turned into an execution, and its steps get no notes (execution.ts:728; F1-recorded-traces.md:150).
7. **Steps land on blocks when a run is opened.** Each call goes to the block that points at its pointer now, falling back to the stored block path. A moved block still lands right, and a deleted one reaches the missing-block line (execution.ts:783-793).
8. **Pruning.** The tracker deletes only files it wrote itself, keeping its newest 200. `listRuns` prunes the folder to the newest 200 that are not kept. Fragmentor never deletes anything else.

Rejected: `fragmentor track <command>` (PROJECT.md:200: the person types no Fragmentor commands); loading the tracker from Fragmentor's install (the line would name an install path); a relative `--import` (it fails when an app starts from a subfolder); Python in Phase 1 (one language first); store and queue steps before Phase 4 (drawn code has no capability seam).

## Phases

### Phase 1a: capture runs from a TypeScript app run with tsx (L, develop-module)
**Goal:** prove on drawn code, with no window changes, that a real run is heard exactly and read back as a trace with real times.

**Changes:**
- **`src/run/track.mjs` (new template, no dependencies).**
  - Everything in Approach 2-4 and 8, ES modules only.
  - It does nothing off the main thread, because the loader thread inherits `NODE_OPTIONS`.
  - A file is matched to a pointer by its project-relative path. The path is decoded from its `file:` URL, case-folded on the drive letter, and also tried as its real path (junctions).
  - A failed write is retried once, then only that run is dropped. If the tracker itself fails, that file is left untouched and the app carries on.
- **`src/run/runs.ts` (new):**
  - `writeTracker(projectDir, snapshot)` calls `ignoreAllButShared`, then writes `.fragmentor/track.mjs` through a temporary file and a rename. The file embeds, for each function block that is not planned (`role === "function"`, src/model/testing.ts:26), its `file#name` pointer, block path, `inputs` names and single `outputs` name.
  - It returns three lines, one each for PowerShell (`$env:NODE_OPTIONS="--import=file:///…"`), Command Prompt and bash, using the percent-encoded file URL, since `--import C:\…` fails.
  - It also returns the function blocks it cannot follow, with why: a whole-file pointer, a method, a `const`, or a non-JS/TS file. When there are no TypeScript or JavaScript function blocks, it says that instead.
  - `listRuns` prunes, then reads line 1 of each file: kept runs first, then newest first.
  - `readRun` uses `resolveInside` (src/project/safePath.ts:11) and checks the file against a zod schema.
- **`src/model/recorded.ts`:** `return` and `throw` carry `at` (since the analytics work, 2026-10-12), and a `Return` built from them carries `took`, the one field for how long a call took (src/model/trace.ts). New pure `capturedRun(file, blocks)` builds a `RecordingScope`: `runs` is the first call's block, `blocks` maps each path to its pointer, and the rest is empty. It returns `{trace, took}`, with `took` keyed by answer step id and `trace.execution` set to the run id (trace.ts:150).
- **`src/model/trace.ts:137-145`:** add `"captured"`, with its meaning in the comment.
- **`src/cli.ts`:** add `runs [id]` to `USAGE` (38-67) and to the project commands (907).
  - `runs` writes the tracker, then prints this platform's line, the blocks not followed, and the newest 20 runs with their ids.
  - `runs <id>` prints block names indented by depth, each with its time, short values, and "ended with an error: …" where a call threw. It does not reproduce the bar's sentences, which live in the window (execution.ts:47, 89).
- **`examples/messenger/package.json` (new): `{"private": true, "type": "module"}`.** Without it, a copy under the temporary folder takes `C:\Users\quinn\package.json`, which has no `type`, so tsx compiles to CommonJS.
- **`examples/messenger/src/main.ts` (new, about 35 lines, typechecked by `check:examples`).**
  - It imports `./workers/delivery.js`, since nothing else does (server.ts imports only the router).
  - It seeds users `ada` and `bo` directly into `db`.
  - Then: Bo signs in; Ada signs in with the wrong password, and the script catches the error; Ada signs in; Ada sends `bo` "hi"; Ada signs out through `dispatch`; `cleanUpSessions(Date.now() + 2 days)` runs.
  - Then it prints the page's lines. The page is a single `state` (client/state.ts:11), so the expected lines are "ada: hi" from delivery (delivery.ts:13), then "you: hi" (state.ts:21).
- **`scripts/copy-app-assets.ts:15-22`:** copy `track.mjs`.
- **Guide (if Decision 5 is yes):** one sentence after `{{commands}}` in guide.md (21-25), within guide.test.ts:172-178.

**Verification:**
- **`src/run/track.test.ts`**, on a Messenger copy under a temporary path containing a space, running `main.ts` with tsx from the repository (S2). It checks that:
  - there are six runs: Login Form three times, Send Button, State (signing out), and Clean Up Sessions;
  - the log-in run goes Login Form → State → Router → Log In, with `{email, password: "(hidden)"}`, and Log In gives back `{sessionId: "(hidden)"}`;
  - in the wrong-password run, Log In throws "That email and password do not match.", Router, State and Login Form throw the same, and the run ended with an error;
  - the send run goes Send Button → State → Router → Check Session, Save Message, Notify Recipient → Deliver Notification → State → Chat View, and then the outer State → Chat View;
  - the output is identical with and without the tracker;
  - a fixture block that starts an HTTP server gives one run per request, and a timer set inside a call gives a run of its own;
  - `process.exit` mid-run and an uncaught error both leave the run written, and the error still exits with the same code;
  - a process that loads no block file writes nothing;
  - `git check-ignore` covers the run files.
- **Fixture tests:**
  - `length`, `name` and `this` are kept, and a synchronous return stays synchronous;
  - an unhandled rejection is still unhandled, and a getter is never called;
  - the secret-name list hides what it should;
  - 2001 calls set `cut`, and so does 1 MB;
  - a parent's time excludes its children's copying.
- **`recorded.test.ts`:** `capturedRun` with a trigger from outside, exact causes, `took` on nested and thrown calls, no `state`, a moved pointer landing on the current block, and a vanished pointer falling back to the stored path.
- **`cli.test.ts`:** `runs` and `runs <id>`.
- **Order:** `npx tsc --noEmit`, then each new test file alone, then the whole suite once, alone.

**Human verification (PowerShell):**
1. In the Fragmentor folder, run `npm run fragmentor -- runs --project examples/messenger`. Expect a line starting `$env:NODE_OPTIONS=`, "No runs yet", and no blocks listed as not followed.
2. Open a new PowerShell window. Run `cd "C:\Users\quinn\OneDrive\CS Projects\Fragmentor\examples\messenger"`, paste the line, press Enter, then run `..\..\node_modules\.bin\tsx src\main.ts`. Expect "ada: hi" then "you: hi".
3. Close that window, so the setting goes with it. Repeat step 1. Expect six runs, each with its time in ms and an id, one marked "ended with an error".
4. Run `npm run fragmentor -- runs <id of the Send Button run> --project examples/messenger`. Expect the indented sequence above, with Deliver Notification under Notify Recipient, and no password or session id visible.
5. Run `git status`. Nothing under `examples/messenger` should appear.

A problem would be: fewer runs, Deliver Notification missing, every time 0, a password or session id visible, files listed by git, or different program output.

**Done when:** the tests pass, S1, S2, S4 and S5 pass, and the person has seen the six runs.

### Phase 1b: compiled and CommonJS apps (M)
- **`src/run/track.mjs`:** a `_compile` hook for CommonJS. A symbol stops a file seen by both hooks from being wrapped twice. A compiled file is matched to its pointer through its source map's single `sources` entry.
- **Verification:**
  - a tsc CommonJS build of the Messenger copy into `dist/` with source maps gives the same six runs;
  - a plain `require` JavaScript fixture is followed;
  - a compiled file without a source map is left untouched and listed as not followed.
  - No separate human check: what the person sees is identical to Phase 1a.

### Phase 2: Open a Run of Your App… in the window (L)
**Goal:** the person steps through a real run on the tree and as a Flow, with real times.

**Changes:**
- **`app/main.ts`:**
  - Menu: `open-run`, "Open a Run of Your App…", above Export (5967), enabled in `offerProjectMenu` (5994-5999).
  - Handlers: `listRuns` and `readRun`.
  - `cpSync` at 94 gains a filter that skips `.fragmentor`, so the person's own runs never reach the self-check's copy.
  - In `watchProject` (261-293), when the project changes and `track.mjs` exists, rewrite it, so a moved pointer never leaves it stale.
- **Wiring:**
  - `app/ipc.ts`: `"open-run"` in `MenuCommand` (64), two `CHANNELS` (22-61), and two `FragmentorApi` methods (139-214).
  - `app/preload.cjs`: the hand-kept channel copy (10-49) and the two methods (53-94).
  - `wireMenu` (app.ts:600-609).
- **`app/renderer/runs.ts` (new; add to `APP_ONLY`, copy-app-assets.ts:37-39):**
  - It opens through `openWindow` (popup.ts:37) as "Runs of your app", with the subtitle "Saved on this computer only. Never committed or exported."
  - `section("Runs")`: one button per run. The program's name is added only when the runs come from more than one program, for example "· from vitest". "Ended with an error" is red only when the error reached the top of the run.
  - `section("Start your app so Fragmentor sees it")`:
    - on Windows, chips for PowerShell, Command Prompt and Git Bash, remembered in `localStorage` as state.ts:238 does;
    - `phraseLine` (app/renderer/notes.ts:167) with the line, and the purpose "to paste into the terminal you start your app from";
    - then: "Then start your app there as usual, and use it. Close that terminal to stop."
    - one line naming the function blocks not followed, only if there are any, and "Databases and queues are not seen yet."
    - With no runs, this section comes first.
    - A project with no TypeScript or JavaScript function blocks shows only "Fragmentor can follow apps written in TypeScript or JavaScript for now."
  - Clicking a run calls `readRun`, then `capturedRun(file, snapshot.blocks)`. It sets `ui.appRun`, closes the window, and calls `showAppRun()` in execution.ts. `execution.ts` never imports `runs.ts`; the bundle check would throw (copy-app-assets.ts:52-59).
- **`app/renderer/state.ts`:** `ui.execution.trace` (96) gains `"captured"`, meaning `id` is a run id. New `appRun: {id, label, trace, took} | null` goes beside `recordings` (98). The name `ui.runs` is the bench's (155). `appRun` stays out of `forgetBlocks` (306).
- **`app/renderer/execution.ts`, every site:**
  - `picked` (179-185) and `currentStep` (188-194) return `execution: null` and `run: ui.appRun` while the trace is `"captured"`. `paintExecution` (210-213) then keeps the run.
  - `Start` (76) gains `"app"`. `startOf` (78) takes `execution | null`; its calls are at 219, 238, 589 and 701.
  - `describeStep`: "Your app calls Send Button with …", handled before `ARRIVALS[start!]` (102). The outside is named "Your app" there and in the Flow (248).
  - `stepWord` (107-111) takes the run's `took`: "gives back · 3.2 ms" on the tree (133) and in the Flow (238; flow.ts:91).
  - `SOURCE_NOTES` and `SOURCE_WORDS` (417-423) gain `captured`. The word is "From your app"; the note is "What your app did on this computer. Only calls between functions your blocks point at are seen." This makes 542 and 706 type-check.
  - `renderBar` shows the bar while a run is open (448), and calls `agreementOf` only for an execution (464, 553).
  - `buildBar`: the list (481-482) gains one option for the open run only. There is no Record button (491) and no pill. A run shows one pressed **From your app** chip (536-551).
  - `choose` (264-275): the run's own option selects `trace: "captured"`. `goToStep` (356) and `showRecording` (374) stay for executions only.
  - `stepPage`:
    - the head (706) names "From your app · 14:02:11";
    - notes and verdicts appear only for `declared` (728; `verdictOn` needs an execution);
    - Where (752) reads "your app, outside the blocks";
    - a "took" row goes beside the kind row in the Where list, showing the whole run on the trigger;
    - `recordingSection` (834) and `triggerWords` (842) are never reached for a run.
  - `resetExecutions` (985-991) clears `ui.appRun`.
- **Self-check, on the filtered Messenger copy, added to `selfCheckFailures` (1242):**
  1. `open-run` is disabled with no project (the `closedWithNothingOpen` check at 2463) and enabled with one.
  2. The runs window shows a line and "No runs yet".
  3. After running `main.ts` (S2), six runs are listed, one ending with an error.
  4. Opening the Send Button run presses From your app, there is no Record button, and the caption starts "Your app calls Send Button".
  5. The Flow's box count matches S2, and an answer arrow contains "ms".
  6. The step page has a "took" row and no note button.
  7. In the exported page, the `#fragmentor-export` JSON (exportPage.ts:373) has no "ada@example.com" and no execution. The whole page cannot be searched, because the inlined bundle holds the chip's words (375; viewer.ts:19).

**Verification:** tsc, then `check:app` alone.

**Human verification:**
1. Run `npm run app` and open `examples/messenger` with File › Open Project….
2. Choose File › Open a Run of Your App…. Expect Phase 1a's six runs, with one "ended with an error" in red.
3. Click the Send Button run. Expect **From your app** pressed, and "Your app calls Send Button with …".
4. Press **Step** a few times. Arrows should go Send Button → State → Router → Check Session, with answers reading "gives back · N ms". Click a step: Where should show "took … ms".
5. Press **Flow**. The whole run should be laid out, with times.
6. Pick a written execution from the list. It should look exactly as before.
7. Choose File › Export… and open the page. It should show no run.

A problem would be: a Record button or a note button on a run, the words "Fragmentor runs", red on a run that ended well, or the run on the exported page.

**Done when:** the self-check passes and the person confirms the wording reads plainly.

### Phase 3: keep a run (S)
- **`src/run/runs.ts`:** `keepRun(dir, id, keep)` moves the file between `runs/` and `runs/kept/`. Pruning never touches `kept/`.
- **Wiring:** one channel, `keepRun`, through `CHANNELS`, `FragmentorApi`, the preload copy and a main handler.
- **`execution.ts`:** in the Record slot, a run shows **Keep** as a pressed/unpressed toggle, titled "Keep this run, so it is not cleared away with older ones". It is handed in through `setUpExecutions` (231) as Record is. The viewer hands in nothing, so the page shows no Keep.
- **`runs.ts` window:** `subsection("Kept")` first.
- **Verification:**
  - Unit: keep and unkeep move the file, and pruning spares kept runs.
  - Self-check: keep a run, add 201 fixture runs, and the kept run is still listed.
  - Human: open a run and press Keep. Run `main.ts` again, then reopen the window: the run should be under Kept. Press Keep again: it should be back among the rest.

### Phase 4: traces from the team's tracing system (only if Decision 2 is yes; S6 first) (M)
- **`src/model/otlp.ts` (new, pure):**
  - It reads OTLP JSON: Collector file-exporter lines, Python's json-file exporter, and a single OTLP document, unwrapping Jaeger v3's `{result}`.
  - It turns spans into the run file's events, with parents from `parentSpanId` and `took` from start to end.
  - Spans are placed by `code.function.name` and `code.file.path`, with the deploy folder removed and `.js` matched to `.ts`. Everything else folds into its nearest placed ancestor as "N steps not on the drawing".
  - Tempo's `batches` and database-span placement come only if S6 shows they would place a meaningful share.
- **Runs window:** **Open a trace file…**. Main shows the dialog and reads the file where it lies. Keep copies it into `runs/kept/`, the one home.
- **Fetch by id:** only if Decision 2 is B. Main fetches, because the window allows no requests (index.html:7).
- **Verification:** S6's exports as fixtures. Human: open a Jaeger trace file. Its hops should land on the right blocks, with the rest counted and timed.

### Phase 5: each run plays as it arrives (only if Decision 3 is yes) (M)
- **`watchProject`** (main.ts:261-293) sends new files under `.fragmentor/runs/` on a new push channel, `runArrived` (preload `onRunArrived`, like preload.cjs:58-60), instead of dropping them at 277.
- **The runs window** adds the row, and gains a checkbox, "Show each run as it arrives", off by default.
- **With the checkbox on,** the newest run opens on the bar and plays (Play, execution.ts:566). This happens only when the bar shows nothing or shows the previous run that arrived, and never while the bench is watching a run (`ui.watch`). Nothing else on screen is ever interrupted, and no second overlay competes with the bench's (watch.ts:148-151).
- **Production** (polling Tempo or Jaeger) is planned only if Decisions 2B and 3B are taken, after S6.
- **Verification:**
  - Self-check: dropping a run file in starts it playing without a reload, and dropping one while a written execution is shown leaves that execution alone.
  - Human: turn the checkbox on and run `main.ts`. Each run should start playing within about two seconds.

## Decisions for the person
1. **How you start your app with tracking.**
   - **A. Copy a line** from the runs window, for your terminal, then start the app as usual. It stays set until that terminal is closed. If `.fragmentor/track.mjs` were deleted while it is set, every `node` command in that terminal would fail until you close it.
   - **B. `fragmentor track npm start`.** One prefix that works in any shell, but it is a command you type, which PROJECT.md:200 rules out.
   - **C. A Start button.** Fragmentor would start and stop your code, which comes close to the 2026-10-06 decision.
   - **Recommendation:** A.
2. **May Fragmentor read your team's tracing system?** This changes PROJECT.md:223-229, although nothing is hosted.
   - **A. Trace files only.**
   - **B. Also fetch one trace by id from Jaeger or Tempo.**
   - **C. Not now.**
   - Production traces show service, database and HTTP hops with times, but rarely your own functions.
   - **Recommendation:** decide after using Phase 2. Then A, and only if your team already uses OpenTelemetry.
3. **Live view.**
   - **A. Your own app only.**
   - **B. Also production, by polling.** Needs 2B and S6. Seconds to about 30 s behind, and sampled.
   - **C. Not now.**
   - **Recommendation:** A, after Phase 3.
4. **What a run keeps.**
   - **A. Values, with password-, token- and session-like names hidden.**
   - **B. Steps and times only.** Safer, but you no longer see what each call was given.
   - Either way, runs live only in `.fragmentor/runs/`. Git ignores it, but OneDrive syncs it, and this project is in OneDrive.
   - **Recommendation:** A, and keep projects that hold customer data outside OneDrive.
5. **Teach the agent `fragmentor runs <id>`?** One sentence in guide.md's Commands section, plus the `USAGE` entry. The open run would get a Copy for "fragmentor runs <id>". The values it prints reach your model provider.
   - **Recommendation:** yes, for runs from your own computer.

## Spikes before building
**Already settled** (drafts' spikes in `plans/spikes/real-runs/esm`, and today's checks):
- Node 22.12 has `module.register` but not `registerHooks`.
- A line-1 reassignment wraps function declarations for importers, same-file calls and load-time references, keeping `name` and `length`, strict mode and stack lines.
- Reassigning a `const` throws, and the `try` contains it.
- `--import C:\…` fails; file URLs in `NODE_OPTIONS` work, including with a space in the path.
- The loader thread needs the `isMainThread` guard.
- AsyncLocalStorage context leaks into later requests and into timers.

**To run:**
- **S5 (before Phase 1a). OneDrive and Defender.** 1000 temporary-file-and-rename writes inside this OneDrive folder, and `fs.watch` seeing each rename. **Pass:** no run lost after one retry.
- **S1 (1a; its compiled part before 1b). Setups.**
  - tsx as a CLI under `register`, on Node 22.12 and Electron's Node 24.
  - tsc to CommonJS and to ESM; `export default function`; barrels; async generators; a 4-argument Express handler.
  - Unhandled rejections still unhandled.
  - Whether a same-width `const`→`let ` rewrite is safe.
  - Path forms: `file:` URLs with `%20`, `C:` against `c:`, and junctions.
  - The Command Prompt line with `%20`.
  - **Pass:** the same output and stack lines with and without the tracker.
- **S2 (1a). Messenger.**
  - The exact runs, steps and Flow box count.
  - How the test and the self-check run `main.ts` (tsx from the repository; Electron as Node).
  - Whether `npx tsx` resolves from `examples/messenger` without installing anything.
- **S3. Overhead.** 100k calls. **Pass:** under 10 µs per call for values under 1 KB, and a parent's reported time within 5% or 0.2 ms of the same call untracked.
- **S4. Concurrency.** 50 overlapping async runs, a server-start block, and timers. **Pass:** no call lands in another run, and there is one run per request.
- **S6 (before Phase 4).** Real exports from local Jaeger, Tempo, the Collector file exporter and Python's json-file exporter, for an auto-instrumented Express and pg app. **Pass:** one reader parses them, and the share of spans placed is recorded for Decision 2.

## Risks
- **Tracking changes the app's behaviour.** → Synchronous code stays synchronous, nothing calls getters, and a file is left untouched when in doubt. S1 and the identical-output test check it.
- **A block whose call never ends** (a server's main loop) holds everything in one run. → Caps cut it, it is flushed on exit, and S4 has the server case.
- **`NODE_OPTIONS` reaches npm, tsc and test runners.** → Only processes that load block files write anything, and runs from tests are labelled with their program.
- **A missing `track.mjs`, or Node older than 20.6, makes every `node` command in that terminal fail.** → Fragmentor never deletes the file (it rewrites it by rename), and the window says "Close that terminal to stop".
- **Customer data on laptops.** → Runs are git-ignored twice over and never in the snapshot, export or notes. Secret-like names are hidden from a tested list, unkept runs are pruned, and Decision 4 covers OneDrive.
- **A stale tracker.** → It is rewritten when the project changes, when the runs window opens, and on `fragmentor runs`. Steps are matched by pointer, then by stored path.
- **Node's hook API changes.** → It is confined to one file, and S1 runs on Node 22 and 24.
- **Local times are read as production performance.** → The window says "on this computer", and there are no per-block statistics until production runs exist.

## Out of scope
- **Python:** the natural next feature after Phase 2. It needs `sitecustomize` and the `__code__` swap of harness.py:325-339.
- **Class methods and `const` functions:** until a real project needs them.
- **Store and queue steps through ports:** drawn code has no capability seam.
- **Per-block timing statistics and percentiles:** after Phase 4, and only if production runs exist.
- **Drawing a run on the project at its commit (`projectAt`):** once production runs show version skew.
- **Comparing runs with executions, turning runs into executions, notes on run steps, and marking a run as from an older drawing:** see Approach.
- **Browser code, bundled or serverless builds, Datadog and Honeycomb, storing every production run, sharing runs, and any database or listener.**

## Docs to update
- **PROJECT.md:** 40 gains a third kind of trace, captured from your own running app. 204: the export holds no runs. 223-229 change only if Decision 2 is yes.
- **STATUS.md:** item 2's "proposed, not planned" (8) and Next major steps (160); a Working entry per phase; the blind spots in Known problems.
- **README.md:** one sentence on File › Open a Run of Your App….
- **The guide:** Decision 5's sentence, within budget.
- **The comment in `src/model/trace.ts:137-145`.**

## How the review was handled

Three independent drafts (smallest-first, risk-first, user-first) were merged, then three critics checked the plan against the code (code truth), against the engineering rules (simplicity) and for verification and plain wording. Each point and what became of it:

**Code-truth critique**
1. `ui.runs` already exists. Applied: the new field is `ui.appRun`, kept out of `forgetBlocks`.
2. Temporary copies run as CommonJS. Applied: added `examples/messenger/package.json`, with the CommonJS path tested separately in 1b.
3. Messenger's behaviour. Applied: one page, output "ada: hi" then "you: hi", the nested State → Chat View, delivery imported, and messages sent to `bo`.
4. The self-check copies the person's runs. Applied: the `cpSync` filter skips `.fragmentor`.
5. Assertion 7. Applied: it checks the `#fragmentor-export` JSON, and execution.ts never imports runs.ts. APP_ONLY cited as 37-39.
6. A run's identity and call sites. Applied: the run id is the file name, marked by `trace: "captured"` plus `ui.appRun`, with every site listed (startOf at 238, not 241; the Flow at 248).
7. Pointer-only events. Applied: the block path is stored at capture time and used as the fallback.
8. Guide placement. Applied: guide.md Commands plus USAGE, and Approach 2 narrowed to new empty projects (537).
9. IPC wiring. Applied: FragmentorApi, the preload copy, handlers, the 2463 assertion, `resolveInside`, Phase 3's channel and Phase 5's push channel. The inspector part is moot, since block statistics were dropped.
10. `overlayFor` cannot be reused. Applied by removing the reuse: Phase 5 plays on the bar instead (simplicity 7).
11. Caps. Applied: 2000 calls, not events, with the counter reset for each run.
12. `cd` path. Applied: the full quoted path.

**Simplicity critique**
1. Applied in part: dropped `registerHooks` and methods, and Phase 1 is now 1a (L) plus 1b. Rejected: keeping only the ESM compiled path, because the `_compile` hook needs its one test and CommonJS is common in existing code.
2. Applied: `runs <id>` prints names, times and errors, with stable file-name ids.
3. Applied: the window is the only picker, the bar lists only the open run, "not followed" is said once, and "took" is a Where row.
4. Applied: Phase 3 is the Keep toggle only, with no Forget, and statistics are out of scope.
5. Applied: one home, `runs/` and `runs/kept/`. A trace file is read where it lies.
6. Applied: only function blocks that are not planned, computed once in `writeTracker`.
7. Applied: Phase 5 opens the newest run and plays it, with no overlay adapter.
8. Applied: OTLP plus the `{result}` unwrap, with Tempo and database placement conditional on S6. 5b is reduced to a sentence, kept in Phase 5 because the person accepted production polling.
9. Applied: no `lookForExport` change, self-check item 8 dropped, and the reason for the tracker's own `.gitignore` stated.
10. Applied in part: the line is labelled per shell (with verification-ux 6). Rejected: a relative `--import`, which breaks apps started from a subfolder.
11. Applied: pruning split (the tracker deletes only its own files, `listRuns` prunes the folder), `recordedTrace` called with `{stores: {}}`, and sizes corrected (1a L, Phase 2 L).

**Verification-ux critique**
1. Applied: the open-first-call rule for runs, plus server and timer tests.
2. Applied: pruning as written, the 1 MB and 10 KB caps, the summary line, the program name, and no colons.
3. Applied: the filter. Rejected: running the human check on a temporary copy, which the filter makes unnecessary and which would lengthen the person's steps.
4. Applied (same as code-truth 5).
5. Applied (same as code-truth 3).
6. Applied: shell chips on Windows, "Close that terminal to stop", and both failure modes in Risks.
7. Applied: names by `inputs` in order, outputs named and hidden, a written and tested list of names, and no getters.
8. Applied: the tracker's own time is excluded from every enclosing call, and S3 measures the error in nested times.
9. Applied: flush on `exit` and in `uncaughtExceptionMonitor`, with tests.
10. Applied: stable ids and placement in guide.md.
11. Applied (same as simplicity 6).
12. Applied: the TS/JS-only message, the nothing-to-follow message, rewriting on project change, and the Windows path forms in S1 and the tests. Rejected: the drawing fingerprint, because rewriting covers most cases and the extra message adds clutter.
13. Applied: S5 runs before 1a, with one retry, then only that run is dropped.
14. Applied: "Open a Run of Your App…", "ended with an error" in red only when the error reached the top, and Keep on the open run.
15. Applied: `choose` handles the run's own option, and the list holds only the open run.
16. Applied: live playing never interrupts a shown execution or the bench.
17. Applied: the 1a/1b split.
