# REPORT

**Fragmentor's existing recording: what it does, its data model, and what production traces would need**

All citations are relative to `C:\Users\quinn\OneDrive\CS Projects\Fragmentor`. Nothing was run; every claim below comes from reading the code.

## Verdict
Recording production executions is not implemented. A recording today is a re-run that Fragmentor starts itself, on the developer's machine, of a scenario the agent wrote in `executions/<id>.json`. No customer event, log or trace ever enters it. Recordings are held in window memory only. STATUS.md:8 says capturing runs from the person's own app was "proposed, not planned". The F1 plan deferred both OpenTelemetry ingestion and "attach mode" (scratch/plans/F1-recorded-traces.md:60, 138-142, 521-523; PROGRAMME.md:100).

## Where a recording's inputs come from
- `recordExecution` loads the execution file, takes the `trigger.payload` as the input (`?? {}`) and `given` as the starting store rows (src/run/record.ts:126, 137-138). The window only sends the execution id; main reads the file itself (app/main.ts:610-616).
- The payload is checked against the block's input contract, and the rows against store shapes, before anything runs (src/run/run.ts:203-221).
- `fragmentor test` records every recordable execution the same way, prints a verdict and discards the recording (src/cli.ts:479-515).

## Where the code runs
- Only code held to its contract is run (src/run/run.ts:151-167). It is transpiled into a throwaway `fragmentor-run-*` temp folder (src/run/typescript.ts:41-80), which is deleted after the run (src/run/run.ts:338-340).
- It runs in a separate Node process (`ELECTRON_RUN_AS_NODE`) that reports over IPC (src/run/typescript.ts:256-270; src/run/harness.cjs:3-19). `harness.py` speaks the same messages (src/model/recorded.ts:23).
- The run starts at the last block on the trigger's route (src/run/record.ts:34-69). Fragmentor stands in as the caller: the first call becomes a synthetic `trigger` with `from: null` (src/model/recorded.ts:87-121).
- Limits: 15 s timeout (run.ts:331), 2000 events (harness.cjs:174), values over 200 KB replaced by a description (harness.cjs:176-187).

## What it can and cannot see
- **Sees:**
  - Calls between contract-bound blocks. Each block's export is wrapped, and `AsyncLocalStorage` records which call made which (harness.cjs:275-299, 312-324).
  - Store `read/list/write/remove` and queue `send` on in-memory stand-in stores, never the real database (harness.cjs:51-103, 202-217).
- **Does not see:**
  - Code that is only drawn: not run, listed in `scope.unseen` (record.ts:79-99).
  - Calls inside one file, which bypass the export (recorded.ts:238-256).
  - HTTP: the stand-in throws "no network access" (harness.cjs:139-143).
  - FileSystem, Clock, Random and Logger. These are real but never reported. FileSystem writes real files inside the project (harness.cjs:108-138).
  - The hops before the answering block (recorded.ts:295; app/renderer/execution.ts:947).
  - `deliver` steps (recorded.ts:294).
  - Any effect other than `row-changed`, `row-removed`, `message-published` or `response` (recorded.ts:76).
- **Timing is dropped.** The harness stamps every event with `at` (harness.cjs:215, 282, 292, 295), and `RunEvent` carries it (typescript.ts:83-95). `HeardEvent` leaves it out (recorded.ts:24-37), and trace events have no time fields. Only a total `durationMs` survives (run.ts:80, 270). This matters for the performance idea too.

## Persistence
- `Recording` is described as "Held in this window only, never saved" (app/renderer/state.ts:55-71). It lives in `ui.recordings: Map<executionId, Recording>`, one per execution (state.ts:97-98).
- It is dropped when:
  - the trigger or `given` changes (`basis` check, state.ts:320-335);
  - a re-record fails (watch.ts:388);
  - a different project is opened (execution.ts:985-991).
- It is never exported (state.ts:534-536).

## Trace data model (src/model/trace.ts)
- **Address** (27-30): `{path: "a/b/c", entry: string|null}`, written `path.entry`. The first dot starts the entry.
- **Interaction** (68-87):
  - `type:"interaction"`, `id`, `description?`, `code?` (`file#fn`);
  - `cause: id|null`, `from: Address|null` (null means outside), `to: Address`;
  - `kind`: trigger | call | read | write | remove | send | deliver (55);
  - `payload?`.
- **Return** (100-112): `type:"return"`, `id`, `of` (the interaction's id), `from`/`to` copied from that interaction, `response?`, `error?` (thrown message).
- **Effect** (121-133): `type:"effect"`, `id`, `description?`, `code?`, `cause`, `at: Address`, `kind` (free text), `detail?`.
- **TraceSource** (145): only `"recorded" | "declared"`. The comment says the two are never confused.
- **Trace** (147-162): `source`, `execution` (an execution id), `events[]` in order starting with the trigger, and `state?` (store contents at the end).
- **Recorded ids** are `trigger`, `@N`, `@N.returned`, `@N.effect`, `trigger.response` (recorded.ts:96-176).

**Execution file format** (src/project/executions.ts:180-199, strict schema):
- `name?`, `description?`;
- `trigger {at, kind: action|request|schedule|message|webhook, description?, code?, payload?}`;
- `given {target: {key: row}}`;
- `trace?: step[]`;
- `expect? {entered, interactions, effects, never, state}`.

Step rules:
- An interaction step has `{id?, cause?, description?, code?, from (required, non-null), to, kind ≠ trigger, payload?, response?}` (121-135).
- An effect step has `{id?, cause?, description?, code?, effect, at, detail?}` (137-147).
- Ids must match `^[A-Za-z][A-Za-z0-9_-]*$` (98-100). A missing cause is inferred (226-237). Returns are built only from `response` (317-352).
- A file's `trace` always loads as `declared` (354). Written steps cannot carry `error`, and the file cannot carry `state`.
- A missing `description` or `code`, or a code pointer that resolves nowhere, is reported as an **error** (executions.ts:469-495; src/project/snapshot.ts:308-323).

## Converting OpenTelemetry spans
An OTLP span has `trace_id`, `span_id`, `parent_span_id`, `name`, `kind` (INTERNAL/SERVER/CLIENT/PRODUCER/CONSUMER), start and end nanosecond times, `attributes`, `events`, `links` and `status{code: UNSET/OK/ERROR, message}` (https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto).

A plausible mapping:

| Span | Becomes |
|---|---|
| Root SERVER span | `trigger` Interaction (`from: null`) |
| Child span | Interaction, with `cause` = parent's id and `from` = parent's `to` |
| Span end | Return; `status=ERROR` maps to `error: status.message` |
| CLIENT DB span (`db.collection.name` → entry, `db.operation.name` → read/write/remove) | Interaction, plus a `row-changed` Effect for writes |
| PRODUCER / CONSUMER (`messaging.destination.name`, `messaging.operation.type`) | `send` + `message-published`, and `deliver` |

Sorting the starts and ends by time gives the ordered `events`. Sources: https://opentelemetry.io/docs/specs/semconv/database/database-spans/ and https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/.

Mapping a span to a block needs a reverse index from block `code` (`file#fn`) to path, matched against the stable `code.file.path` / `code.function.name` attributes (https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/).

Gaps:
- Automatic instrumentation emits HTTP and DB spans, not one span per function. The F1 plan judged that a weak match to function blocks (F1-recorded-traces.md:138-141).
- DB query parameters and message bodies are not captured by default, so `payload`, `response` and `detail` would mostly be empty.
- The model has nowhere to keep timestamps, durations, `trace_id`, `links` or resource attributes.
- `Trace.execution` must name an execution id, but a production run belongs to no file.
- `state` is unknowable from spans.

## What the window would show unchanged
- **Trace kernel** (trace.ts:174-294): `place`, `placeEvent`, `nextStep`, `travelOf`, `addressesOf` and `activates`/`enters`. They depend only on addresses.
- **Tree arrows**: `markFor` (execution.ts:128-169).
- **Flow**: `buildFlow`, a linear walk over events (app/renderer/flow.ts:67-110).
- **Step page**: Where, What it carried, What came back, Threw, and Code with "Open the code" (execution.ts:687-821).
- **Jump to a step by id**: `goToStep` (356-367).
- **Comparison**: `checkRecording` would work for any `Trace` given a `RecordingScope` (recorded.ts:382-394).

## Assumptions that would break
1. **No way in.** Recordings reach the window only from `recordRun`, which runs code (main.ts:612-624; watch.ts:361-404).
2. **One per execution.** One recording per execution id (state.ts:98); "Record again" replaces it (watch.ts:271). Many customer runs need a list.
3. **Basis check.** A trace whose payload differs from the file's trigger is discarded on first read (state.ts:320-335), and production has no `given`.
4. **Picker.** Only executions from files appear in the select (execution.ts:447, 482), so a run whose trigger has no file cannot be picked.
5. **Wording.** `source:"recorded"` makes a null start read "Fragmentor runs X" and "Fragmentor, from outside the system" (execution.ts:76-78, 91, 99-100, 248, 752). The Recording section says stores were Fragmentor's own and "nothing is saved" (419-420, 943-947). All of this is false for production, and the two-value `TraceSource` has no honest label for it.
6. **Bench-specific checks.** `RecordingScope` (`runs/blocks/stores/answers/unseen`, recorded.ts:48-63) and its hard-coded rules assume the bench: trigger/deliver never recordable (293-297), the `RECORDED_EFFECTS` list (76), and a response only at `scope.runs` (321-322).
7. **Completeness.** `complete`/`stopped`/`truncated` (state.ts:63-66) would have to absorb sampling and dropped spans.
8. **Notes.** "Leave a note" is withheld on recorded steps (execution.ts:716-728).
9. **Live view.** `watch.ts` holds a single `ui.watch` and ignores events from another `runId` (589-594). Starting a run stops the previous one (328-330), and playback is paced at 280/140 ms (194-199). Concurrent customer runs would collide. `overlayFor` (106-139) lights blocks by block path and store target, so it could be reused for a live view.

## Export precedent for private data (app/exportPage.ts)
- **Field-level allowlist, enforced at compile time.** Every snapshot field is marked kept or dropped in typed tables, so a new field will not compile until someone decides (src/project/snapshotFields.ts:15-60; exportPage.ts:60-94).
- **Dropped as real or private data:**
  - execution `given` and `expect` ("starting rows can hold real data", snapshotFields.ts:167-177), plus `records` and `unrecordable`;
  - trace `state` (240-246);
  - project `dir`, `notes`, `rules`, `diagnostics` (exportPage.ts:166);
  - block `stores`, `sources`, `cases`, and code `excerpt` and `hash` (122, 143);
  - problem messages, kept only as counts (52-53, 262).
- **Folder scrub:** every string, keys included, has the project folder removed and the home folder written as `~`. The patterns cover every path spelling: drive letters, `/c`, `/mnt/c`, `%2F`, `%20`, JSON-escaped backslashes, any case (180-247). Code pointers that lead outside the project are cut to `…/file` (231-237).
- **Final check:** the finished page is searched for either folder and refused with `ExportLeakError` rather than repaired (249-254, 379-382). A content security policy blocks all requests (361-365).
- **Limit:** step `payload`, `response` and `detail` are exported unredacted (`data` = structuredClone, 96-97). Only folder paths are scrubbed. Production traces would need value-level redaction that has no precedent here.

## Constraints a design must respect
- Desktop, local, "nothing needs a server" (PROJECT.md:202).
- Sharing happens through a repository (PROJECT.md:206).
- No production infrastructure just to prove a feature (PROJECT.md:239).
- The F1 plan's view: saving recordings is worth revisiting once recordings can't simply be made again (F1-recorded-traces.md:499).

# VERDICT

**Skeptic review of "current-recording"**

I checked the report's claims about Fragmentor against the code at the cited lines, and its OpenTelemetry claims against the spec pages. Nothing was run. Citations are relative to `C:\Users\quinn\OneDrive\CS Projects\Fragmentor`. The verdict holds: production recording is not implemented. The OpenTelemetry mapping is weaker than the report says.

## (a) Claims refuted or corrected

1. **The messaging mapping is wrong in two ways.**
   - The messaging conventions are still "Development", not stable.
   - By default a producer and its consumers are tied by span **links**, not parent and child. A consumer's `process` span usually sits in a separate trace. So `deliver` can't come from `parent_span_id`, as the "Child span → cause = parent" row assumes.
   - `send` can be a CLIENT span, not only PRODUCER. The operation types are create, send, receive, process and settle.
   - Source: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
2. **The DB attributes are less reliable than the report implies.**
   - `db.collection.name` and `db.operation.name` are stable but only "Conditionally Required": set when "readily available", and not to be pulled out of query text that can name several collections or operations.
   - `db.operation.name` holds the database's own verb (`SELECT`, `findAndModify`, `HMSET`). Mapping it to read/write/remove needs a table for each database.
   - Source: https://opentelemetry.io/docs/specs/semconv/database/database-spans/
   - Node's `@opentelemetry/instrumentation-pg` still emits the old v1.27 attributes (`db.statement` and so on) by default. The stable names appear only with `OTEL_SEMCONV_STABILITY_OPT_IN=database`. Source: https://www.npmjs.com/package/@opentelemetry/instrumentation-pg
3. **Matching spans to blocks by `code.*` is harder than stated.**
   - The attributes are stable and the names are right.
   - But `code.file.path` is an absolute path on the server, which in production is compiled `.js` under the deploy folder, not `src/x.ts`. `code.function.name` is fully qualified. Source: https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/
   - So a reverse index from `file#fn` needs path normalising and source maps.
   - A search summary said Node auto-instrumentation doesn't set `code.*` on its spans. The JS instrumentation docs I fetched don't show it either way, so treat that as unverified (https://opentelemetry.io/docs/languages/js/instrumentation/).
4. **The span shape is slightly incomplete.** It also has `trace_state`, `flags` and three `dropped_*_count` fields. `SPAN_KIND_UNSPECIFIED` exists, and the enum names are `STATUS_CODE_UNSET/OK/ERROR`. Source: https://raw.githubusercontent.com/open-telemetry/opentelemetry-proto/main/opentelemetry/proto/trace/v1/trace.proto
5. **`PROGRAMME.md:100` is mis-cited.**
   - The file is `scratch/plans/PROGRAMME.md`, which STATUS.md:5 says is git-ignored.
   - Line 100 records the 2026-10-06 "NO" on step 27, which is about running drawn code, and that the person proposed capturing runs from their own app. It says nothing about deferring OpenTelemetry or attach mode. That deferral is only in F1-recorded-traces.md:60, 138-142 and 521-522.
6. **Recorded ids are incomplete.** There is also `trigger.returned`: line 129 builds the return id from `call.id`, which is `trigger` for the first call (src/model/recorded.ts:129).
7. **"Missing description or code is an error" is too broad.** It holds for the trigger (executions.ts:472-475) and for interaction steps (488-493). Effect steps are only checked for `at` (481-482).
8. **"Where the code runs" describes TypeScript only.** Python systems run in `python -I -B -X utf8 harness.py` (src/run/python.ts:129), from their own `fragmentor-run-*` copy (python.ts:96). `harness.py` also stamps `at` (harness.py:230-245).
9. **Two small fixes on capabilities.**
   - The FileSystem stand-in is harness.cjs:108-123; lines 124-138 are Logger, Clock and Random.
   - Logger is not "never reported": its lines come back in `RunOutcome.logs` (run.ts:79; harness.cjs:124-128). They just aren't trace events.
10. **"Timing is dropped" needs nuance.**
    - Live `RunEvent`s with `at` do reach the window (watch.ts:589-594), but playback ignores them and uses a fixed 280/140 ms pace (watch.ts:195-199).
    - PROGRAMME.md:101 records that the closing sweep kept `at` on purpose even though nothing uses it.
    - `Recording.at` is the wall-clock time the recording was made (state.ts:68).
11. **Export leaks one more field than listed.** `trigger.payload` is also exported unredacted (exportPage.ts:154; snapshotFields.ts:237).

## (b) Confirmed, one line each

- `recordExecution` reads `executions/<id>.json` and uses `payload ?? {}` and `given` (record.ts:126, 137-138). The window sends only the id (main.ts:610-620).
- The input and starting rows are checked against contracts before anything runs (run.ts:203-221).
- Only code held to a contract runs (run.ts:151-167).
- Runs use a temp copy, deleted afterwards (typescript.ts:41-80; run.ts:338-340), in a separate `ELECTRON_RUN_AS_NODE` process over IPC (typescript.ts:256-270).
- Limits: 15 s timeout (run.ts:331), 2000 calls and store uses counted together (harness.cjs:174, 192-193), 200 KB per value (harness.cjs:176-187).
- Calls are seen by replacing exports plus `AsyncLocalStorage` (harness.cjs:275-299, 312-324). Stores and queues are in-memory stand-ins (51-103). The HTTP stand-in throws (139-143).
- Calls inside one file are not heard (recorded.ts:238-256). Trigger and deliver can't be recorded (293-297). `RECORDED_EFFECTS` (76). A response only at `scope.runs` (321-322).
- `HeardEvent` has no `at` (recorded.ts:24-37). The trace types have no time fields (trace.ts:68-162).
- `TraceSource` is only "recorded" or "declared" (trace.ts:145).
- Recordings live in memory only (state.ts:55-71, 97-98).
- Recordings are dropped on a basis change (state.ts:320-335), on a failed re-record (watch.ts:388) and when a project opens (execution.ts:985-991). The only writers are watch.ts:271 and 334.
- `fragmentor test` records each execution and discards the recording (cli.ts:479-515).
- The execution file schema is as described (executions.ts:98-100, 121-147, 180-199). A file's `trace` loads as `declared` (354).
- The recorded-wording lines are as described (execution.ts:76-78, 91, 99-100, 248, 752, 417-420, 943-947).
- The picker lists only file executions (execution.ts:447, 482). Notes are withheld on recorded steps (728).
- The kernel, `markFor`, `buildFlow`, `goToStep` and the step page sections are as described (trace.ts:174-294; execution.ts:128, 356-367, 714-816; flow.ts:67-110).
- Export: the compile-time field tables, `given`/`expect`/`state` dropped as real data, the folder scrub, `ExportLeakError` and the content security policy (snapshotFields.ts:160-178, 240-246; exportPage.ts:150-254, 347-383).
- STATUS.md:8 says capturing runs from the person's own app is "proposed, not planned". PROJECT.md:202, 206 and 239 say what the report says.
- The F1 plan deferred OpenTelemetry and attach mode, and judged automatic spans a weak match for function blocks (F1-recorded-traces.md:60, 138-142, 499, 521-522).

## (c) Missed or wrongly weighted

1. **The most direct constraint is missing.** PROJECT.md:223-229 lists as out of scope "any hosted service" and "deploying or operating the software Fragmentor builds". Watching production is close to operating it, so this is a scope change the person has to approve, not only a design question.
2. **A database isn't required.**
   - The Collector's file exporter writes OTLP JSON lines, with rotation and compression. It is "alpha" for traces, and an OTLP-JSON file receiver can read them back. Fragmentor could read those files locally. Source: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/fileexporter/README.md
   - For the live view: the batch processor's default delay is 5 s, and a span is exported only when it ends, so the root span arrives last. "Live" would mean seconds late. Source: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
   - The default sampler keeps every trace, but production setups often sample, keeping all errors and a percentage of the rest. So "every customer run" is a choice, not a given. Source: https://opentelemetry.io/blog/2022/tail-sampling/
3. **OpenTelemetry is over-weighted. An in-process recorder fits better, but ESM breaks the current trick.**
   - The guide has entry points "create the real capabilities and call the blocks" (src/codegen/guide.ts:519-520), and capabilities are passed whole (PROJECT.md:220). Wrapping the capabilities once at the entry point would see every store use. A recorder reusing the harness's wrapping would produce `HeardEvent`s that `recordedTrace` takes unchanged, at block level, with no span mapping.
   - The catch: the harness's interception works only because Fragmentor compiles to CommonJS, whose exports can be replaced (typescript.ts:48-50, 66; harness.cjs:315-317).
   - The guide starts new TypeScript projects with `"type": "module"` (guide.ts:537). ES module bindings can't be swapped by a preloaded script, so this needs loader hooks or wrapping at build time. Calls inside one file stay unseen either way.
4. **The main upside is under-stated.** Capturing in production runs nothing, so the "only code held to a contract" limit (run.ts:151-167) disappears for existing codebases. STATUS.md:8 says this itself.
5. **A replay option is missing.** Capture only the trigger payload and the rows read at the entry point, write an execution, and record it again locally with today's machinery. That reuses everything, but Clock and Random are real (harness.cjs:129-138), only code held to a contract can be replayed, and customer data ends up in files.
6. **Storage and private data are under-weighted.**
   - The only sharing channel is the repository (PROJECT.md:206). Traces holding customer data must not be committed. The F1 plan's local, uncommitted `.fragmentor/recordings/` option (F1-recorded-traces.md:495) is the only precedent that fits.
   - The export already drops starting rows and end state as "real data" (snapshotFields.ts:167-177, 244). Production payloads are all real data, so they would need dropping, not just redacting.
7. **Matching a production run to an execution is unaddressed.**
   - The natural join is the root server span's `http.route` plus `http.request.method`, matched to a service's exposed operation and then followed with `answeringRoute`. `http.route` is set only when the framework supports it.
   - HTTP bodies are never captured; only opt-in size attributes exist. So the trigger payload would be empty. Source: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
8. **Feature 2 (architecture metrics) isn't covered**, so the report has no book-metric claims to check.