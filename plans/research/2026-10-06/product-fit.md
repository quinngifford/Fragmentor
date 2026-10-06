# REPORT

**Assessment: production runs and architecture metrics in Fragmentor**

## 1. Production runs: what exists today

**Fragmentor does not capture production runs. Nothing it holds comes from a real customer.**
- **Declared traces** are the agent's reading of the code. They are "never presented as something observed" (PROJECT.md:40).
- **Recorded traces** come from Fragmentor running the code itself, from the execution's written payload and starting rows, "with stores of its own standing in for the real ones" (app/renderer/execution.ts:417-420). The stores are dictionaries, not databases (STATUS.md:90). Recordings live only in memory (STATUS.md:8).
- The F1 plan deferred OpenTelemetry and "attach mode" (scratch/plans/F1-recorded-traces.md:60,138,521-522). It said saving recordings should be revisited only when runs "cannot simply be made again" (F1:499). Production runs are exactly that case.
- On 2026-10-06 the person decided not to record code that is only drawn, because "runs captured from the person's own application would show the same thing truthfully" (STATUS.md:8, commit 40c83f0). That makes capture the answer to the programme's "biggest value gap": a buyer's existing code gets nothing verified (PROGRAMME.md:512).

## 2. Production runs: fit and smallest useful version

**It does not need a database.** The team's tracing backend (Jaeger, Tempo, Datadog and similar) already stores production traces, with sampling and retention. Fragmentor should read them, not store them.

**How the pieces line up:**
- A block's `code` pointer (`file#function`, PROJECT.md:48) matches OpenTelemetry's stable `code.function.name` and `code.file.path` ([otel code attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/)).
- Database tables match the stable `db.collection.name` and `db.operation.name` ([db spans](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)).
- Spans have parents. That matches `HeardEvent`'s call/return/throw/store events with parent ids (src/model/recorded.ts:24-37), so `recordedTrace` and the "could not see" honesty of `RecordingScope.unseen` (recorded.ts:57-62) carry over.
- The OTLP file format is JSON Lines, but it is still at "Development" status ([file exporter](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/)).

**Smallest useful version: open one run from a file.**
- **File › Open a run…** (beside Export, app/main.ts:5963-5967) reads a trace exported from the team's backend.
- Fragmentor maps spans onto blocks. Spans it cannot place are listed as "not on the drawing".
- The run is matched to an execution by its trigger (route ↔ operation address).
- The bar's sources (execution.ts:423) gain a third, "From your app", shown only when such a run exists. It is stepped through on the tree and as Flow, as today.
- `TraceSource` (src/model/trace.ts:145) gains a third value, and PROJECT.md:40 is reworded.
- Each step gets its real duration. **That is the honest performance view** (section 5).
- Runs are stored under `.fragmentor/captured/`. That folder is already git-ignored by default, since only versions, notes and rules are shared (src/project/history.ts:1186). So it is local and never committed, with no new mechanism.

**Leave out:**
- **Storing every production run.** That is an observability vendor's job.
- **A live view of production.** It needs a standing network link to production telemetry. That is a hosted, operational service, which PROJECT.md:202, 227, 229 and 239 rule out.
- If "watch it light up" is wanted later, the local version fits: Fragmentor listens on localhost for the developer's own locally running app. Even that makes the app a server, against "nothing needs a server" (PROJECT.md:202). That is the person's call.

**Risks:**
1. **Customer data.** Span attributes carry personal data and query text. Notes are committed (src/project/notes.ts:24-31), and a flagged run copies input and output into the note (notes.ts:40-60). So flagging a captured step must carry the step reference and the finding, never the values. The export must drop captured runs: the field inventory forces that decision before it compiles (src/project/snapshotFields.ts:15-30).
2. **Coverage.** Node's automatic instrumentation covers libraries and frameworks ([zero-code JS](https://opentelemetry.io/docs/zero-code/js/)). Spans for the buyer's own functions need manual instrumentation. So captured runs will show the service, database and queue hops well and function steps patchily, and the window must say "could not see" rather than imply a full trace.
3. **First ten minutes.** This only helps buyers who already have tracing set up. It is not a first-run feature.

## 3. Architecture metrics: what Fragmentor already does

Fragmentor already covers the half of the book that leads to action. The book pairs metrics with automated governance ("fitness functions", for example ArchUnit cycle and layer checks) and warns that metrics need context ([notes](https://bagerbach.com/books/fundamentals-of-software-architecture/)). In Fragmentor:
- **Rules** are the person's own fitness functions over dependencies, made by clicking, with a reason (PROJECT.md:19; src/model/rules.ts:1-14).
- **Undeclared reach** is a warning with Flag (STATUS.md:39; src/project/reach.ts:469).
- **Problems** each have Flag, which leaves a note (app/renderer/inspector.ts:41-74, Flag at :62; notes.ts:368-389).
- **Review**, the `fragmentor review` command, already asks the agent whether each block "should be split or merged" (src/codegen/commands.ts:49). That is the judgment of cohesion and granularity, left to the agent, which fits "Fragmentor never calls a model" (PROJECT.md:150).
- **The status bar** already shows blocks, code found, checked, errors and warnings with good/warn/bad tones (app/renderer/app.ts:483-498).

**The raw data exists but is hidden.** Code-derived reach edges are computed on every snapshot (src/project/snapshot.ts:402) but kept only for warnings and rules. The block panel's Reaches lists only declared outgoing access (app/renderer/detail.ts:182-217). No panel shows what reaches a block.

## 4. Metrics: why the book's numbers mislead here

I ran a read-only scratch script over copies of the examples with the kernel's own reach reader (scratchpad/research/reach-metrics.mts).
- **tickets** (13 blocks, 15 dependent pairs): `tickets-db` is reached by 5 blocks, instability 0. The entry points `box-office`, `reminders` and `reserve` have instability 1.00.
- **messenger** (22 blocks): `database` is reached by 6. `router` reaches 5.
- Neither has a cycle.

**What this shows:**
1. **Most of the book's metrics do not fit the block model.**
   - *Distance from the main sequence* needs abstractness. Every function block is a concrete function with a types-only contract, so abstractness is always 0. The score then reduces to 1 − instability and puts every database at the worst possible value.
   - *Cohesion (LCOM)* needs classes and fields, and blocks are functions.
   - *Connascence* mostly cannot be computed from the code alone. Its static forms are already caught by typechecking against contracts.
   - *Scalability* is a runtime measure, so it cannot be computed from code at all.
2. **High numbers are often by design.** A shared part sits beside what uses it (PROJECT.md:17), so being reached by many is the architecture working as Fragmentor teaches. Red would land on the database and on `find-event`.
3. **The numbers measure the agent's decomposition as much as the code.** Granularity is chosen per project (PROJECT.md:56,184). The json-server rebuild had 23 function blocks, 19 of them drawn in words (scratch/trials/findings.md:7,15), so the sample is small.
4. **TypeScript and Python would disagree.** Reach is read only for TypeScript; Python is held to declared access alone (STATUS.md:94). The same number would mean different things in each language.
5. **Red/green clashes with the existing colour meanings.**
   - Red means wrong (PROJECT.md:102), and failed blocks glow red (app/renderer/styles.css:863-865).
   - Green means "carries data" (styles.css:1-2) and "your own code" (`function: #37dc89`, app/renderer/state.ts:425).
   - The palettes are the person's own (STATUS.md:155).
   - A red-to-green gauge would tell people a judgment is a fault.

## 5. Metrics: where a view would live

- **Not on the toolbar.** It holds only Commands and the two panel switches (app/renderer/index.html:17-24).
- **Not as a bar.** The bars above the drawing announce something new: notes waiting, or what changed since you looked (index.html:69-76; notes.ts:959; app/renderer/changes.ts:231). A permanent bar of numbers breaks "nothing visible before it is relevant" (scratch/plans/first-time-review.md:25).
- **Not as a third colour mode** beside by block and by kind, for the reasons in point 5 above.
- **If a view is wanted after all:** a window like Commands (app/renderer/popup.ts:37) opened from View (app/main.ts:5974-5977). Nothing new on screen by default.

## 6. Metrics: smallest useful version (facts, no scores)

1. **"Used by" under Reaches** in every block panel, listing what reaches the block, each with the existing Show button. This is fan-in and fan-out in plain words.
   - It needs reach edges added to the snapshot, classified in snapshotFields.
   - The exported page reuses `reachesSection` (app/renderer/viewer.ts:91), so the export gets it at no extra cost.
2. **A cycle warning.** When two sibling parts reach each other, it appears as an amber warning in Problems, with the evidence. Flag already turns it into a precise note, so no new UI is needed.
   - A note saying "improve coupling" gives the agent nothing specific to do. A note naming the cycle and its evidence does.
   - A note must sit on a block (notes.ts:389-390), and this one has a natural block.
3. **Weak-point analysis goes to the agent, not the window.** `fragmentor check` lists the most-reached blocks, the most-reaching blocks and any cycles. `review`'s steps add one sentence asking the agent to weigh them. Its findings come back as notes, through the loop that already exists.

**Leave out:** composite scores, gauges, thresholds, trend charts, abstractness/distance, LCOM, connascence and "scalability".

## 7. Performance

- The bench already reports a total time per run (src/run/run.ts:270; app/renderer/bench.ts:273). With dictionary stores in a sandbox, that number says little about real performance.
- Real per-step times come only from captured runs (section 2). Show a step's real duration on its page and in Flow. No dashboard.

## 8. Export and "everything local"

**What local means today:**
- A project is a folder plus git.
- Per-person state (colours, the Changes bookmark) stays in the app's browser profile (changes.ts:43).
- The window's security policy is `default-src 'none'` (index.html:7).
- The exported page makes no requests and holds no code, notes or tests (PROJECT.md:204). It carries only problem counts (app/exportPage.ts:52-53; viewer.ts:109-118).

**Recommendations for the export:**
- Keep "Used by" lines on the page, which come at no extra cost.
- Keep metrics and captured runs off it entirely.

## 9. Scope against the programme

Neither idea helps the first ten minutes on a buyer's repo. Metrics on a fresh rebuild would grade the agent's decomposition and show red on code the buyer cannot yet act on.

**Order I would recommend:**
1. **"Used by" and the cycle warning.** Small, factual, and they reuse Flag and notes.
2. **Open a run from a file**, kept local, never committed or exported. This is the real answer to verifying drawn code.
3. **Later, and the person's decision:** a localhost listener for live runs from the developer's own app.

**Never:** live production, a store of every run, or red/green scores.

# VERDICT

**Skeptic review of the "product-fit" report**

## (a) Claims refuted or corrected

1. **"Neither [tickets nor messenger] has a cycle."** This is wrong for messenger. The report's script (`scratchpad/research/reach-metrics.mts`) only looked for two blocks that reach each other directly. I lifted each code-reach edge to the level of sibling blocks and ran a full cycle search (`scratchpad/research/skeptic-cycles.mts`, on unmodified copies). Messenger has a cycle between `app/client/ui` and `app/client/state`:
   - `state` reaches `ui/chat-view`: `examples/messenger/src/client/state.ts:2` imports `showMessage` from `./ui/chatView.js`.
   - `ui/login-form` and `ui/send-button` both reach `state` through `dispatch`.
   - Tickets has no cycle.

   Two consequences. The proposed warning for "two sibling parts reach each other" catches this only if edges are lifted to the sibling level, because `chat-view` is not a sibling of `state`. And the warning would fire on a bundled example.

2. **"Database tables match the stable `db.collection.name`."** The attribute is stable, but the Postgres instrumentation (`pg`) does not emit it. Its README says the driver "does not expose the table name separately" ([README](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js-contrib/main/packages/instrumentation-pg/README.md), lines 82-85). Tickets and messenger both use PostgreSQL.
   - The spec says the collection name SHOULD NOT be pulled out of query text when one query can touch several collections ([db spans](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)).
   - instrumentation-pg emits the stable names by default only from 0.72.0. The opt-in migration documented for 0.55.0+ kept the old v1.27 names (`db.statement`, `db.name`) unless `OTEL_SEMCONV_STABILITY_OPT_IN=database` was set. So the mapper has to accept both naming sets and get table names from the query text.

3. **"`code.function.name`/`code.file.path` match the `file#function` pointer."** Both attributes are stable ([code attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/)), but they do not match the pointer directly.
   - `code.function.name` is defined as the fully qualified name in the runtime's natural form.
   - My inference: in production, the file path is the deployed `.js` path, not `src/…ts`, so matching needs path normalisation or source maps.
   - Zero-code instrumentation does not instrument application code ([zero-code concepts](https://opentelemetry.io/docs/concepts/instrumentation/zero-code/)), so these attributes exist only where the team adds spans by hand.

4. **"A live view … is a hosted, operational service, which PROJECT.md:202, 227, 229 and 239 rule out."** This overreads the cited lines.
   - :227 sits under "Not in scope now", which is not a permanent ban.
   - :229 is about deploying or operating the software Fragmentor builds.
   - :239 is development-strategy advice against building production infrastructure just to prove a feature.
   - A desktop app polling the team's existing Tempo or Jaeger query API hosts nothing.

   On "even a localhost listener makes the app a server": :202 means nothing remote is needed. F1 itself planned "an OTLP receiver in main" (`scratch/plans/F1-recorded-traces.md:139`). There is also an option with no listener at all: the Collector's file exporter (alpha for traces, in the core distribution, [README](https://raw.githubusercontent.com/open-telemetry/opentelemetry-collector-contrib/main/exporter/fileexporter/README.md)) writes JSON Lines that Fragmentor's existing file watcher could follow.

5. **"Reads a trace exported from the team's backend" (one format).** Each backend exports a different shape.
   - Jaeger's v3 API returns OTLP wrapped in `{"result":…}`; its UI download is Jaeger's older JSON ([Jaeger APIs](https://www.jaegertracing.io/docs/2.dev/architecture/apis/)).
   - Tempo's trace-by-ID JSON used `batches` instead of `resourceSpans` ([grafana/tempo#3802](https://github.com/grafana/tempo/issues/3802)).
   - The OTLP file format the report cites is still "Development" ([file exporter](https://opentelemetry.io/docs/specs/otel/protocol/file-exporter/)).

6. **"Span attributes carry personal data and query text."** This overstates what spans hold by default. Query text that is not parameterised should be collected only with literals replaced, and query parameters are not captured unless switched on ([db spans](https://opentelemetry.io/docs/specs/semconv/database/database-spans/)). The privacy risk still exists, through URLs, user ids, custom attributes and opt-in settings. But the bigger consequence is the reverse: a captured run shows which steps happened and how long each took, mostly without the values. That does not deliver the person's "see exactly what happened".

7. **"Cohesion (LCOM) needs classes and fields, and blocks are functions."** Not all blocks are functions. `component` blocks group functions (STATUS.md:41). An LCOM4-style count (separate groups of children that share no stores and make no calls to each other) is computable from access and reach edges. For example, it could ask whether `pricing`'s `price-seat` and `refund-for` share anything.

8. **"Connascence's static forms are already caught by typechecking against contracts."** Only name and type are caught. Meaning, position (arguments of the same type swapped) and algorithm are not. Typechecking also covers only code held to a contract, and most real code is only drawn (19 of 23 blocks on json-server, `scratch/trials/findings.md:7`).

9. **"TypeScript and Python would disagree."** Only code-derived reach is limited to TypeScript (STATUS.md:94). Declared `access` exists in every language. My run found the same cycle in messenger whether or not declared edges were included. Metrics built on declared access, checked against code where it can be read, would be consistent across languages.

10. **"The json-server rebuild … 19 of them drawn in words … so the sample is small."** This does not follow. Reach is read through `code` pointers whether or not a block has a contract. 21 of 23 pointers were declared (findings.md:7), and the trial rebuilds produced real reach warnings (STATUS.md:39).

11. **"Red/green clashes with the existing colour meanings."** Only partly. The status bar already uses green, amber and red tones for counts (`app/renderer/styles.css:795-797`; `app.ts:490-500`), which the report itself cites in section 3. The real objection is that a threshold presents a judgment as "wrong" (PROJECT.md:102). Colour itself is not the problem.

12. **"The bars above the drawing announce something new."** Not true of all of them. The execution bar shows whenever executions exist (`app/renderer/execution.ts:448`).

13. **Citation and wording fixes:**
    - "notes.ts:368-389" (Flag) and "notes.ts:959" are in `app/renderer/notes.ts`. The rule that a note must sit on a block is in `src/project/notes.ts:386-389`, not 389-390.
    - Flag appears only when the problem's block exists (`app/renderer/notes.ts:369-370`), and problems in execution files get none (`inspector.ts:52`).
    - `.fragmentor/` is ignored only once `ignoreAllButShared` has run (`src/project/history.ts:1194`, called from notes, rules, versions and swaps). A writer of captured runs must call it too.

## (b) Confirmed

- PROJECT.md:40: declared traces are never presented as something observed.
- `execution.ts:417-420`: the recorded-trace note says Fragmentor's own stores stand in for the real ones.
- STATUS.md:8 and commit 40c83f0: the "runs captured from the person's own application would show the same thing truthfully" reasoning.
- STATUS.md:90: stores are dictionaries.
- F1:60, 138-140, 499, 521-522: OpenTelemetry and attach mode were deferred.
- PROGRAMME.md:512: the "biggest value gap".
- `recorded.ts:24-37` and 57-62: `HeardEvent` and `RecordingScope.unseen`.
- `trace.ts:145`: `TraceSource` has two values.
- `main.ts:5967` (Export) and 5976 (View › Commands).
- `history.ts:1187`: `.gitignore` keeps only `versions/`, `notes/` and `rules.json`.
- `src/project/notes.ts:24-31` and 40-60: notes are committed, and a flagged run copies input and output.
- `snapshotFields.ts:15-30`: every snapshot field must be classified before it compiles.
- `commands.ts:49`: review asks whether a block "should be split or merged".
- PROJECT.md:150: Fragmentor never calls a model.
- `snapshot.ts:402`: reach edges are computed but not put in the snapshot (only `reachNotChecked`, line 527).
- `detail.ts:182-217`: Reaches lists declared outgoing access only.
- `viewer.ts:91`: the export reuses `reachesSection`.
- `exportPage.ts:52` and `viewer.ts:109-118`: the export carries only problem counts.
- `index.html:7`: `default-src 'none'`.
- `index.html:17-24`: the toolbar holds Commands and the two panel switches.
- `styles.css:863-865` and `state.ts:425`: failed blocks glow red, and functions are green.
- `run.ts:270` and `bench.ts:273`: the bench reports one total time per run.
- Fan-in: `tickets-db` 5 and messenger's `database` 6 reproduced.
- Zero-code instrumentation covers libraries, not application code ([source](https://opentelemetry.io/docs/concepts/instrumentation/zero-code/)).
- The OTLP file format is still "Development".

## (c) Missed or mis-weighted

- **Cyclomatic complexity is left out entirely.** It is the book's main structural measure: computable per function, so one-to-one with function blocks. The book also gives a threshold: industry says under 10, and the authors prefer under 5 ([citation](https://imtnd.hatenablog.com/entry/cyclomatic-complexity)). That undercuts "leave out thresholds". It is the one book metric that fits the block model natively.
- **Architecture quantum.** This is the book's structural handle on scalability: a unit that can be deployed independently, with high functional cohesion and synchronous coupling. Services sharing one database form one quantum ([summary](https://github.com/pkardas/notes/blob/master/books/fundamentals-of-architecture.md); [quanta](https://vijayanant.com/posts/architectural-quantum-modular-deployable-architecture/)). It is computable from Fragmentor's service, database and queue blocks, so "scalability cannot be computed from code at all" misses the static half.
- **One run's durations are not a performance view.** The honest numbers are percentiles across many runs, which the team's backend already aggregates. The bench harness records no per-call timestamps (`HeardEvent`, `recorded.ts:24-37`).
- **Attach mode** (F1:142, 521) was the planned local "click in your real app" path, and it sees individual functions, which OTel does not. The report picks an OTLP listener without weighing it.
- **Matching a production run to a written execution by route is lossy.** An execution has starting rows (STATUS.md:18). A production run should probably be its own trace, not a third version of a written one.
- **A committed note pointing at a captured run nobody else has** will dangle for teammates. F1 rejected notes on recorded steps because "their ids live in no file" (F1:150).
- **Retention and sampling decide whether a given customer's run exists at all.** Tempo deletes after 14 days by default ([Tempo config](https://grafana.com/docs/tempo/latest/configuration/)). This argues for saving selected runs locally, not against it.
- **Reach is not read at past commits** (`snapshot.ts:400`). Coupling over time would need its own walk through git history.