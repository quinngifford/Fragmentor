# Weak Spots (architecture findings): plan

## What the person asked for
The person has been reading *Fundamentals of Software Architecture*. They want Fragmentor to measure modularity and coupling, grade each measure from red to green, name the parts that drive it, find weak points, and send any of them to the agent. After the assessment they accepted a narrower version:
- a window opened from View that lists specific findings, worst first;
- a Flag button on each finding that leaves a precise note with the evidence;
- a "Used by" list on every block;
- colour only where a published threshold exists, and coupling shown as plain counts;
- the agent seeing the same findings.

## What it will do
- **Phase 1 (agent only):** nothing changes on screen.
  - When there are weak spots, `fragmentor check` prints one line about them.
  - `fragmentor weak-spots [block-path]` lists each spot with its evidence:
    - on Messenger: "State and UI use each other", citing `showMessage` and `dispatch`;
    - functions with more than 10 ways through them (none in either example);
    - what was not measured.
  - On Tickets it says "No weak spots found" and still lists what it looked for.
- **Phase 2:** clicking a block shows a **Used by** list under Reaches. Each row names the user, says "in the code: showMessage" or "on the diagram: reads events", and has **Show**.
- **Phase 3:** **View › Weak Spots** opens a window. Nothing new is on screen until then.
  - The window has two sections:
    - **Weak spots:** one heading per kind, carrying its count, with that kind's rows under it, cycles first;
    - **Used the most:** plain counts.
  - Each row is itself the Show button and has **Flag** beside it.
  - Flag leaves a plain note. The agent either fixes the spot or replies saying why it should stay. Once the spot is gone, its row is gone.
- **Phase 4 (conditional):** weak spots from git history.
  - 4a: "changes often and is hard to follow".
  - 4b, only if 4a proves useful: "always change together".
- **Phase 5 (conditional):** the largest blocks, as plain facts.

## Approach
1. **One list of who reaches whom, shared with rules.**
   - `evaluateRules` already merges declared access (resolved) with code-reach edges, each marked exact or not (src/project/rules.ts:141-163).
   - That merge moves out as an exported `reachSeen(project, reach)`. Each entry gains `on: "diagram" | "code"`. `evaluateRules` then calls it.
   - Its output goes into the snapshot as `reachSeen`. Rules, cycles, counts and Used by therefore cannot disagree.
   - Only exact entries are used. Approximate code edges are already covered by the undeclared-reach warnings (reach.ts:484).
2. **One pure module, `src/project/weakSpots.ts`, with no imports from node or zod.**
   - Like changes.ts, it takes only types from snapshot.ts, so the window and the export bundle can load it. The window loads unbundled modules (app/renderer/index.html:7, :109).
   - reach.ts imports `node:fs`, `history.js` and `project.js` (reach.ts:1-11), so nothing may be imported from it or from history.ts. Instead, `holding()` (reach.ts:63-68) moves into weakSpots.ts and reach.ts imports it from there.
   - weakSpots.ts carries its own one-line `inside(a, b)`. The renderer already repeats it (versions.ts:125, watch.ts:39).
   - It never uses `fold`, so paths keep their original case.
3. **Cycles.**
   - Each exact entry is lifted to the two sibling children of the deepest block that holds both ends. An entry between a block and its own parent or part is skipped.
   - Tarjan's algorithm then finds the cycles, as in plans/research/2026-10-06/skeptic-cycles.mts. Each group with two or more members is one spot.
   - Its evidence lists every entry as "in the code" or "on the diagram", with "(planned)" where it applies. That way an intended push design shows which arrows close the loop.
   - The note goes on `holding(members)`. When the members are systems, `holding` returns `""`, so the note goes on the first member in sorted order instead.
4. **Complexity piggybacks on the reach parse.**
   - It is counted in `parseText` (typescriptReach.ts:185), which is cached with the parse (:102-110).
   - `FileReach` (pack.ts:63-79) gains optional `functions: {name, top, line, paths}[]`.
   - Each function is credited by reach's own rules, in this order:
     1. `bySymbol` on its qualified name, then on its top-level name;
     2. the one function block whose walker followed it as a helper in its own file (reach.ts:294-295); this gets recorded as it is walked;
     3. `restOwner` (reach.ts:161-174);
     4. otherwise it is under no block.
   - A complex function under no block, such as glue in Tickets' `src/server.ts`, is listed with no Flag, because no block can hold the note.
5. **Counting rule: classic McCabe, per function.**
   - A function starts at 1 and gains 1 for each `if`, `?:`, loop, `case` with a test, `catch`, `&&`, `||`, `??`, `&&=`, `||=` and `??=`.
   - `?.` and default values add nothing.
   - Nested functions are counted on their own and named by the variable or property they are assigned to. Failing that, they are named by position ("2nd function inside send"), never by line, so a headline survives edits.
   - USAGE prints the rule, naming it as cyclomatic complexity.
6. **Users are direct users, everywhere.**
   - `usersOf(snapshot, path)` returns the blocks with an exact entry whose `to` is `path`, excluding its ancestors and its parts. Declared access to one's own store part is common.
   - The Used by panel and the "Used the most" count use the same definition, so they always agree. A component's parts show their own users.
   - Planned users are listed and counted, marked "planned".
7. **Colour uses the status bar's tones** (styles.css:20, :1089-1102, :603-604).
   - The middle tone is the grey-blue `--pending`, which is the default `.problem` border. Amber (`--effect`) already means effects.
   - Red is used only past the hard limit (Decision 3).
   - A kind that was not measured shows "not measured" with no tone, never a green "none".
8. **Flag reuses `problemFlag`.**
   - `problemFlag` (app/renderer/notes.ts:368-388) is parameterised by three things: how it recognises an open flag, what it writes, and its status words.
   - One helper in weakSpots.ts writes the note and also recognises it. The note's first line is exactly "Weak spot: <headline>". Headlines carry no counts or line numbers.
   - The note ends: "Fragmentor found this. Improve it, or reply saying why it should stay. `fragmentor weak-spots <path>` shows whether it is still there."
   - It is a plain note, not `problem`, which shows as a red "ERROR:" (notes.ts:743-747).
9. **Weak spots are never problems.** They never enter `diagnostics`, so the status bar, the Problems sections and check's result do not change.

**Rejected:**
- Weak spots under Problems: on screen by default, and it would fire on bundled Messenger.
- A toolbar button, a bar or a colour mode: clutter.
- A second TypeScript walker: ownership would be duplicated.
- ESLint, radon or dependency-cruiser as dependencies: dependency-cruiser works per file, not per block.
- Abstractness, distance from the main sequence, LCOM, connascence, scores and gauges: the person excluded them.
- Listing every spot in `check`: check runs after every change and the agent reads all of it. About 100 rows on a large codebase would cost context on every run. A top-10 cap would hide the spot the person flagged, so the agent could not confirm its fix.
- Redrawing the window on each new snapshot: windows are short-lived and share one overlay (popup.ts:37-57). Reopening reads the current snapshot.

## Phases

### Phase 0: checkpoint and spikes (S)
**Goal:** a recoverable start, with the risks retired before any repository code is written.

**Changes:**
- (git) Use version-control to branch `weak-spots` from `block-notes`, which is clean at 40c83f0.
- Run S1-S3 in the scratchpad.

**Done when:** each spike passes, or this plan is revised first.

### Phase 1: measuring and weak spots for the agent (develop-module) (L)
**Goal:** cycles, complexity and users are computed from real code and the diagram, and proven by tests and the CLI on both examples.

**Changes:**
- **src/project/rules.ts:** export `ReachSeen` (with `on`) and `reachSeen()`, taken from :141-163. `evaluateRules` calls it.
- **src/lang/pack.ts:63-79:** add optional `functions` to `FileReach`.
- **src/lang/typescriptReach.ts:** `parseText` (:185) counts per the rule, and `reading` (:511-548) passes the counts on.
- **src/project/reach.ts:**
  - `ProjectReach` (:51-60) gains `complexity: { functions: {block | null, name, file, line, paths}[]; measured: Record<system, number> }`. Only functions over 10 are listed.
  - The walker records the helpers it follows (:294-295).
  - One pass after reading credits each function as Approach 4 describes. Files under no block, skipped at :400-403 today, are read for it. Tests stay excluded (:409).
  - `holding` is imported from weakSpots.ts.
- **src/project/snapshot.ts:** `reachSeen` and `complexity` are filled beside `rules` (:539-551) and `reachUnpointed` (:576), so both are empty at a commit. When reach throws (:398-410), `reachSeen(project, null)` still gives the diagram's arrows.
- **src/project/snapshotFields.ts:** both new fields go into `projectFields` (:64-87) as `ignoredPrivate`, for the reason `reachUnpointed` gives.
- **app/exportPage.ts:166:** both fields are dropped. On the page, `usersOf` then finds nobody, so Used by never appears there, including in the Details window, which the viewer also uses (viewer.ts:78, :184).
- **src/project/weakSpots.ts (new):**
  - `weakSpotsOf(snapshot)` returns `{cycles, complex, notMeasured, usedMost}`.
  - It also exports `usersOf`, `holding`, `weakSpotNote(spot)` and `isWeakSpotNote(text, spot)`, plus the threshold constants.
  - `notMeasured` is worked out per system, with these reasons:
    - "Python code is not read yet";
    - "the code could not be read";
    - "no code yet";
    - "only .ts and .tsx files are read" (typescriptReach.ts:88).
- **src/check/check.ts:** `CheckReport` (:48-96) gains a `weakSpots` count, taken from the snapshot at :104.
- **src/cli.ts:**
  - `formatReport` (:161) adds one line after Rules (:226-246), and only when there are spots: "Weak spots: N, which are not problems. `fragmentor weak-spots` lists them; weigh them when the person asks for a review, and change nothing for them otherwise."
  - A `weak-spots` branch goes in the dispatcher (:907-930) before the `rest.length > 1` check, with its own message for too many arguments. Otherwise the command would fall through to `notes()`.
  - USAGE (:38-69) gains the command and the counting rule.
  - The command prints what was looked for, each spot with its block, `file:line` and evidence, and then what was not measured. It always exits 0 and writes nothing.
- **src/codegen/guide.test.ts:217:** add `weak-spots` to the program list.

**Verification:**
- **typescriptReach.test.ts:** each counted construct adds exactly 1, while `default` and `?.` add 0. A nested arrow function is counted alone and named by its variable or by position. `Class.method` is counted alone.
- **reach.test.ts, conservation:** every function is credited exactly once. Cases:
  - a function pointer whose own-file helper it calls;
  - a helper called by two function blocks, which goes to `restOwner`;
  - a method pointer beside a whole-file owner;
  - one file pointed at by two blocks;
  - a folder holding a function block;
  - a file under no block.
- **weakSpots.test.ts, on hand-made snapshots:**
  - a cycle through nested parts is lifted to siblings, and a three-block cycle is reported once;
  - a parent and its part never form a cycle, and an approximate-only cycle is not reported;
  - a cycle made only of diagram arrows says "on the diagram";
  - a cycle between systems puts its note on the first member;
  - grades: nothing at 10, `warn` at 11, `bad` at 16 under Decision 2's (a);
  - `usersOf` excludes ancestors and parts and marks planned users;
  - for each of these, "no weak spots" is never claimed and `notMeasured` names the system: Python, reach null, plan-first with no code, and mixed TypeScript and Python;
  - the note helper recognises its own text, and a mixed-case file name keeps its case;
  - the output is identical when the input order changes.
- **cli.test.ts:**
  - Messenger: one cycle on `app/client`, citing `showMessage` and `dispatch`;
  - Tickets: no spots;
  - block scope works, and check prints its one line only for Messenger.
- **snapshot.test.ts:** `reachSeen` is filled, and it is empty with `atCommit`.
- **changes.test.ts:** add `projectEdits` entries for both fields (:525-553). They will not compile without them.
- **exportPage.test.ts:** after :82, check that both fields are empty on the page.
- **Commands to run:** each touched test file, one at a time; then `npm run typecheck`; then `npx tsc -p tsconfig.app.json --noEmit`, since `typecheck` covers only `src/` and exportPage.ts changes; then the full vitest once, on its own.

**Human verification:**
1. In a terminal in the Fragmentor folder, run `npm run fragmentor -- weak-spots --project examples/messenger`.
   - **Expect:** "Parts that use each other in a circle: 1", under `app/client`, with lines naming `showMessage from src/client/ui/chatView.ts` and `dispatch from src/client/state.ts`.
   - **Expect:** "Functions with more than 10 ways through them: none".
2. Run `npm run fragmentor -- check --project examples/messenger`.
   - **Expect:** the "Weak spots: 1" line, and the same Result as before.
3. Run `npm run fragmentor -- weak-spots --project examples/tickets`.
   - **Expect:** "No weak spots found", and both kinds listed as looked for.
4. Run `git status`.
   - **Expect:** clean.
5. Any of these means a problem:
   - any spot on Tickets;
   - a different cycle on Messenger, or none;
   - a check line on Tickets;
   - a changed file.

**Done when:** the tests, both typechecks and the person's run all pass, and a checkpoint commit has been made.

### Phase 2: Used by in every block's panel (S)
**Goal:** what reaches a block is shown where people look at that block.

**Changes:**
- **app/renderer/detail.ts:** `usedBySection(block)` goes after `reachesSection` (:181-217). It reads `requireSnapshot()` as detail.ts already does.
  - It uses `usersOf` and gives one row per user: the name (plus "planned" where it applies), a quiet line ("in the code: showMessage" or "on the diagram: reads events", built from the user's own access line), and Show (`revealBlock`), as Reaches does (:203-205).
  - It returns null when nobody uses the block.
- **Where it is added:** inspector.ts:354 and popup.ts:259. It is not added to viewer.ts:91, because the page carries no `reachSeen`. It is not added to changes.ts:317.

**Verification:**
- A self-check step, `usedByListed`, added to `selfCheckFailures` (app/main.ts:1242):
  - Tickets leg:
    - Find Event lists Book Seats and Cancel Booking;
    - Tickets DB lists 5 rows, all "on the diagram", with Reminders marked planned;
    - Box Office has no Used by section.
  - Messenger leg, after `noCommitsYet` (:5770): Chat View lists State, "in the code: showMessage".
- `exportPage.test.ts`: the page holds no Used by text.
- One `npm run check:app`, run on its own.

**Human verification:**
1. Run `npm run app` and open Tickets from the start screen. Click **Find Event**.
   - **Expect:** under Reaches, **Used by** lists Book Seats and Cancel Booking, each with "in the code: findEvent".
2. Click **Show** on Book Seats.
   - **Expect:** Book Seats is selected.
3. Click **Tickets DB**.
   - **Expect:** five rows saying "on the diagram: reads …" or "on the diagram: writes …", with Reminders marked planned.
4. Click **Box Office**.
   - **Expect:** no Used by section.
5. Tell the implementer whether it bothers you that Book Seats' own Reaches does not list Find Event (Decision 6).
6. Any of these means a problem: an empty heading; a block listed as used by its own parent or part; Show selecting the wrong block; anything else new on screen.

**Done when:** check:app passes and the person confirms.

### Phase 3: View › Weak Spots, with Flag (M)
**Goal:** the person sees the weak spots and hands any one of them to the agent.

**Changes:**
- **Menu:**
  - app/ipc.ts:64: `MenuCommand` gains `"show-weak-spots"`.
  - app/main.ts: a "Weak Spots" item goes after Commands (:5976). Its id joins `offerProjectMenu` (:5995) and `closedWithNothingOpen` (:2462-2463).
  - app/renderer/app.ts: the item is wired in `wireMenu` (:601-609).
- **app/renderer/weakSpots.ts (new):** `openWeakSpotsWindow()` opens through `openWindow` (popup.ts:37) with the subtitle "Read from the code and the diagram".
  - **Weak spots:** a `section()` (dom.ts:35). Inside it there is one `subsection()` (dom.ts:42) per kind:
    - "Parts that use each other in a circle: N";
    - "Functions with more than 10 ways through them: N".

    Each heading is toned `good` at none and untoned otherwise. A kind that was not measured reads "not measured: <reason>" with no tone.
  - **Rows:** each is a `button.problem` that is itself Show, as in inspector.ts:51-66, with Flag beside it. `.error` is used only for `bad`, and no level word is printed. Show calls `closeWindow()` (popup.ts:24) and then `revealBlock` (canvas.ts:663). The first 10 rows are shown, then "Show all (N)". A row under no block has neither Show nor Flag.
  - **Used the most:** a `section()` holding the top 5 by `usersOf` count, with Show and no Flag.
- **app/renderer/notes.ts:** `problemFlag` (:368-388) is generalised as Approach 8 describes, and a weak-spot wrapper uses it. Its `sent` callback, from `write` (:235), swaps the button for "flagged". Its status words: "Flagged the weak spot on Client for your agent. Tell it “fragmentor notes” when you are ready."
- **scripts/copy-app-assets.ts:37:** add `weakSpots` to `APP_ONLY`.

**Verification:** two self-check steps, added to `selfCheckFailures`:
- `weakSpotsNone`, on the Tickets copy:
  - both headings say none, in green;
  - there are no rows;
  - Tickets DB (5) comes first under Used the most;
  - no window is open when the project opens.
- `weakSpotsCycle`, on the Messenger copy, after `noCommitsYet` (:5770) and before close-project (:5782), so no later step inherits its changes:
  - The step first appends a 12-path and a 17-path function to `src/client/ui/loginForm.ts`, which the `src/client/ui` folder pointer gives to `app/client/ui`.
  - Expect the cycle row first, then a red row (17) and a grey-blue row (12), both on `app/client/ui`.
  - Show on the cycle hides the overlay and selects `app/client`.
  - On reopening, Flag on the cycle writes a note under `.fragmentor/notes/` whose first line is the headline. The row reads "flagged", and the note card has no `.note-error`.
- No error is logged.
- Run `npm run check:app` on its own, and capture screenshots for the person.

**Human verification:**
1. The implementer prepares `C:\Users\quinn\AppData\Local\Temp\fragmentor-work\weak-spots-check`: a Messenger copy with git initialised and one commit, plus the two functions in `src/client/ui/loginForm.ts`.
2. Run `npm run app`, then choose File › Open Project… and open that folder.
   - **Expect:** nothing new on screen.
3. Choose **View › Weak Spots**.
   - **Expect:** "Parts that use each other in a circle: 1", with the Client row.
   - **Expect:** "Functions with more than 10 ways through them: 2": a red row saying "17 ways through (published limit 15)", then a grey-blue row for 12.
4. Click the cycle row.
   - **Expect:** the window closes and Client is selected.
5. Reopen the window and click **Flag** on the cycle.
   - **Expect:** the row says "flagged" and the status bar confirms it.
   - **Expect:** Client's Notes shows the note in plain words, not a red ERROR.
6. In that folder, tell Claude Code "fragmentor notes".
   - **Expect:** it fixes the cycle or replies why it should stay.
   - After a fix, reopen the window. **Expect:** the cycle heading says none, in green.
7. Any of these means a problem: red on the cycle row; the window opening by itself; a change in problem or warning counts; Flag offered again while the note is open.

**Done when:** check:app passes, the person has done the loop, and a checkpoint commit has been made.

### Phase 4a: changes often and hard to follow (M; conditional on Decision 7 and S5)
**Goal:** a complexity spot that also changes often ranks first.

**Changes:**
- **src/project/history.ts:** `codeChanges(projectDir, files)`.
  - It checks `gitState` (:481) first.
  - Then it makes one `git()` call (:63): `log --no-merges -z --name-only --since=12.months -n 1000 -- <files>`.
  - It counts commits per file, using `fold` (:192), and reports a shallow clone.
- **weakSpots.ts:** a complexity spot whose file changed in at least 5 commits becomes "changes often". It ranks first among complexity spots, and the count goes in the evidence only.
- **IPC:**
  - ipc.ts: an entry in `CHANNELS` (:22-61), and an API method beside `changePoints` (:175);
  - preload.cjs: the channel (:29) and its wrapper (:75);
  - main.ts: a handler beside :663.
  - The window asks on open and shows "Reading history…". The CLI calls `codeChanges` in-process. Nothing is cached.

**Verification:**
- history.test.ts, on `ticketsHistory` (history.test.ts:89) with added commits: the counts, a match that differs only in case, and a shallow clone being reported.
- weakSpots tests: the threshold at its edge.

**Human verification:**
1. Open one of your own projects with real history, for example the json-server rebuild, and open View › Weak Spots.
2. For a "changes often" row, run `git log --oneline --since=12.months -- <file>`.
   - **Expect:** at least 5 commits.
3. A problem: a row whose file has fewer than 5 commits in that time.

### Phase 4b: always change together (M; only if 4a proves useful)
The pair rule from the draft:
- two blocks, neither inside the other, sharing no file and with no entry either way;
- changed together in at least 5 commits and in at least 75% of each one's changes;
- commits touching more than 30 code files are skipped;
- the note goes on `holding()`.

It needs `fileOwners` in `ProjectReach`, and its thresholds are tuned against more than one repository first.

### Phase 5: largest blocks (S; conditional on Decision 4 and S4)
- Statements inside each function are counted in the same pass and credited by the same owner rule.
- "Largest" in the window gives the share of measured statements, as plain facts with Show and no Flag, unless S4 finds a rule that is quiet on small projects.

### Phase 6: verify, review, record (S)
Run verify-feature, then the reviewer subagent on the branch diff, then project-status. Update the docs, then merge into `block-notes`.

## Decisions for the person
1. **Name.**
   - "Weak Spots" is plain and is your own idea of finding weak points.
   - "Findings" leaves a first-time user asking "of what?".
   - "Architecture Check" clashes with `fragmentor check`.
   - **Recommend Weak Spots** for the menu, the window and the command.
2. **Complexity limits.** Tickets' worst function has 5 ways through and Messenger's has 7. Fragmentor's own code has about 100 functions over 10, 60 over 15 and 30 over 20.
   - (a) List over 10, red over 15 (NIST's most, with a stated reason).
   - (b) List over 10, red over 20 (ESLint's default): less red.
   - (c) List over 5, red over 10 (the book's preference): long lists.
   - **Recommend (a).**
3. **Red in a window of non-problems.**
   - (a) Red only past the hard limit, always with the words "past the published limit of 15". This is what you asked for (red to green). The cost: Fragmentor's own code would show about 60 red rows while the status bar says 0 errors.
   - (b) Two tones only (green for none, grey-blue for some), with the limit in words.
   - **Recommend (a).** Red then means past a published limit, which is a kind of wrong, and the words say which.
4. **Large blocks.** The book's rules (over 10% of the code, or 2 standard deviations above the mean) flag tiny functions on the examples. Measuring size also has to decide how methods, module-level code and nested blocks count. `review` already asks whether a block should be split.
   - **Recommend Phase 5 as facts,** after S4.
5. **Used by on the exported page.**
   - (a) Left off: no code.
   - (b) Diagram users only: a small filter in exportPage.ts.
   - **Recommend (a) for now.**
6. **Should Reaches also list what the code reaches?** Without it, Find Event says Book Seats uses it while Book Seats' Reaches is silent about Find Event.
   - **Recommend not now.** Answer during Phase 2's check instead.
   - If yes, three things are needed: the rows must exclude the block's own parts (Book Seats imports its part Reserve); `reachesSection` needs the snapshot; and changes.ts:317 must pass none for past snapshots.
7. **History.**
   - Build 4a after using Phase 3 on a real repository.
   - Build 4b only if 4a proves useful.
   - **Recommend as stated.**
8. **Messenger's State↔UI cycle.**
   - Keep it as the bundled demonstration, or fix the example.
   - **Recommend keep,** and say so in STATUS.

## Spikes before building
- **S1, counting rule.**
  - How: hand counts for the examples' worst functions (5 and 7) and for ten of Fragmentor's own functions, compared with a scratch counter.
  - Comparing with ESLint needs a download, so only with your approval.
  - Pass: every count matches the rule.
- **S2, ownership.**
  - How: crediting on copies of both examples plus an overlapping-pointer fixture.
  - Pass: every function is credited once, helpers go to their function block, and `Class.method` goes to its method.
- **S3, cost.**
  - How: time `readProjectReach` with and without measuring (Messenger takes 133 ms today) and on a drawing over Fragmentor's `src/`. Also measure how much the snapshot JSON grows with `reachSeen`, since the snapshot crosses IPC on every reload.
  - Pass: at most 10% or 50 ms more, whichever is larger; `weakSpotsOf` under 50 ms; under 10% more snapshot bytes.
- **S4, size rule (before Phase 5).**
  - How: statements per block on both examples and the T2 realworld rebuild (scratch/trials/findings.md:52).
  - Pass: a rule with no findings on the examples and at most 3 on realworld.
- **S5, history (before 4a).**
  - How: on this repository with scratch blocks, and on the json-server rebuild.
  - Pass: one `git log` under 1 s, and you recognise the top five.

## Risks
- **A function credited to the wrong block** → reach's own owner rules, including the helper rule, plus the conservation tests and S2.
- **A method block's reach stays approximate,** because reach reads the whole file (reach.ts:379-384), so it may be missing from Used by and from cycles → say so in STATUS. Its complexity is still exact.
- **A threshold applied to counts made under a different rule** → the rule is fixed, printed in USAGE and pinned by fixtures.
- **False cycles** → exact entries only, lifted to siblings, never a block with its own part.
- **Intended push designs flagged as cycles** → the evidence says which arrows are "on the diagram", and the agent can reply that a spot should stay.
- **"No weak spots" read as healthy when nothing was measured** → `notMeasured` per system, with no green shown for it.
- **Counts inflated by pass-through capabilities** (block.ts:30-36): Tickets DB counts Book Seats → rows say "on the diagram", and the count always equals the rows.
- **The agent "fixes" weak spots unasked** → they are never problems, and check's line says to change nothing.
- **The guide is full** (guide.test.ts:172) → no guide change. The wording lives in CLI output and the note.
- **A note that is too long** → evidence is capped at 8 lines plus "and N more", under `MOST_NOTE_TEXT` (src/project/notes.ts:127).
- **Leaks into exports** → snapshotFields, the `APP_ONLY` list and the bundle guard (copy-app-assets.ts:51-56).
- **Conflicts with the real-runs feature** in main.ts, app.ts and notes.ts → land the two one after the other.
- **The machine crashes** → vitest and check:app run one at a time.

## Out of scope
- **Abstractness, distance from the main sequence, instability numbers, LCOM, connascence, composite scores and gauges:** you excluded them.
- **Accepting or hiding a spot:** a spot you decide to keep, including Messenger's cycle, stays listed. A dismiss list would be new state, so it waits until you ask for it.
- **Python measures.** Trigger: a Python project in real use. They would need a path into the snapshot through rules.py (src/check/rules.py:14).
- **Detecting pass-through capabilities:** reading `caps.<port>` misses destructuring and renaming, and hiding a user would make Used by disagree with that block's Reaches.
- **Trends over time:** reach is not read at a commit (snapshot.ts:400).
- **Real and static performance:** real numbers belong to the real-runs feature. A call inside a loop needs call positions, which reach does not record.
- **Weak spots on the tree, in the status bar or under Problems.**

## Docs to update
- **PROJECT.md:** one paragraph under "Relationship between the diagram and the code" (:124): weak spots are findings with evidence, never scores and never problems; colour appears only against a published limit.
- **STATUS.md:**
  - Working: each phase as it lands.
  - Known problems: TypeScript only; the counting rule; declared access in the counts; method blocks; the Messenger demonstration cycle.
  - Human verification items.
- **README.md (:36):** one sentence on View › Weak Spots, Used by and `fragmentor weak-spots`.
- **The guide:** no change. USAGE carries the command and its rule.

## How the review was handled

Three independent drafts (smallest-first, risk-first, user-first) were merged, then three critics checked the plan against the code (code truth), against the engineering rules (simplicity) and for verification and plain wording. Each point and what became of it:

**Code-truth critique**
1. `holding`, `under` and `fold` imports: **applied.** `holding` moves into the pure weakSpots.ts, which has its own one-line `inside`, and `fold` is never used there.
2. Ownership drops helpers, and the "never disagree" claim: **applied.** Added the helper rule (reach.ts:294-295) and fixtures, dropped the claim, and listed under-no-block functions without Flag. Module constants no longer matter once size leaves Phase 1.
3. `weakSpotsGraded` would find nothing: **applied.** The functions go into Messenger's `loginForm.ts`, which `app/client/ui` owns.
4. Infrastructure counted first: **applied.** Direct users everywhere, so the panel and the count share one definition (verified: database 6, tickets-db 5).
5. Used by reaches the export through `openDetailsWindow`: **applied differently.** `usersOf` reads only `reachSeen`, which the export drops, so no viewer parameter is needed.
6. Duplicated merge, and planned blocks: **applied.** `reachSeen()` is extracted from `evaluateRules` and stored in the snapshot. Planned users are listed, counted and marked.
7. App typecheck: **applied.** Added `npx tsc -p tsconfig.app.json --noEmit` and dropped "no app changes" from the Phase 1 title.
8. Missing test edits: **applied** (changes.test.ts, exportPage.test.ts).
9. Flag-matching contradiction: **applied.** One helper writes the note and recognises it.
10. Show behind the window: **applied.** `closeWindow()` is called first, and the self-check asserts it.
11. The redraw overwriting other windows: **resolved** by removing the redraw (simplicity 3).
12. CLI fall-through: **applied.**
13. Menu self-check: **applied** (`closedWithNothingOpen`).
14. Phase 4 IPC entries: **applied.**
15. Python path contradiction: **resolved** by moving Python to Out of scope.
16. `holding` returns "": **applied.** The note goes on the first member.
17. Citations: **applied** (reach.ts:409, :161-174; changes.ts described as "pure, no node or zod").

**Simplicity critique**
1. Size cut from Phase 1: **applied.** It is now conditional Phase 5, and "under no block %" is gone. Decision 4 records that this defers something you accepted.
2. Drop the command: **rejected.** Check's output is read on every run, and a cap would hide flagged spots the agent must confirm. **Partly applied:** coupling facts are left out of agent output.
3. No redraw: **applied.**
4. No export code: **applied.**
5. Defer Decision 5: **applied.** It is now Decision 6, asked during Phase 2.
6. Split Phase 4, no cache: **applied.**
7. Python to Out of scope: **applied.**
8. Four self-check steps become two: **applied.**
9. Parameterise `problemFlag`: **applied.** The name collision is fixed with weakSpots.ts. **Rejected:** putting the window in notes.ts, which is already over 1000 lines; the `APP_ONLY` cost is one word.
10. Shrink the spikes: **applied.** ESLint is only with approval, and S4 moved to Phase 5.
11. Drop "Uses the most": **applied.**

**Verification-UX critique**
1. Imports break the bundle: **applied** (as code-truth 1). The app typecheck was added. check:app builds the bundle.
2. Red for non-problems: **applied as Decision 3,** recommending red with words. "Not measured" has no tone.
3. Methods: **applied.** Counting is per function by qualified name, and approximate method edges are listed under Risks.
4. Inflated counts: **partly applied.** The Tickets DB count of 5 is pinned with "on the diagram" rows. **Rejected:** detection and collapsing, with the reasons given in Out of scope.
5. Own parent listed: **applied.** The experiment found no such code edges, but declared access to one's own parts needs the guard.
6. "Under no block": **applied.** Removed.
7. Flag bugs: **applied** (full-prefix match, position names, no `fold`, a mixed-case test).
8. Window mechanics: **applied** (Show closes the window, rows are buttons, no level words, no redraw).
9. Ranking across kinds: **applied.** Grouped by kind, cycles first.
10. Wording: **applied** ("ways through", new subtitle, no approximate rows). The "How connected" split and the jargon are gone with size and fan-out.
11. Edge cases: **applied** (plan-first, reach null, mixed languages, snapshot size in S3).
12. Self-check order: **applied** (after `noCommitsYet`). Ownership: **rejected.** `restOwner` returns undefined for price-seat.ts (reach.ts:161-171), so the functions now go to loginForm.ts. Wording unified.
13. Agent loop: **applied.** The note names the command, and kept spots are listed in Out of scope.
14. Decision 5 details: **applied** inside Decision 6.
15. Push designs and the ESLint download: **applied** (Risks, S1).
