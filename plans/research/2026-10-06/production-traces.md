# REPORT

**Report: capturing real production runs and replaying them in Fragmentor**

**Answer to "is this already implemented?"** No. Fragmentor has two kinds of trace: `declared` (the agent wrote it) and `recorded` (src/model/trace.ts:145). A recording runs the code in Fragmentor's own sandbox. It starts from the payload the execution's trigger names and puts stand-in stores in place of the real ones (src/model/recorded.ts:11-18). It only covers code held to its contract, and it is kept in memory and never saved (STATUS.md:8, :33). Every `executions/*.json` file is written by the agent and always loaded as `declared` (src/project/executions.ts:78). Nothing comes from customers. The only trace of OpenTelemetry in the repo is an optional peer dependency of vitest (package-lock.json:1759).

**What already lines up.** The sandbox harness already does what a tracing library does:
- It replaces each block's exported function with a wrapper (src/run/harness.cjs:275-298, :313-318).
- It uses AsyncLocalStorage to know which call is the parent of which (:190).
- It reports every store read, write, remove and send (:202).
- It caps a recording at 2000 calls and 200,000 characters per value (:174, :176).

The harness emits `HeardEvent`s: call, return, throw and store (src/model/recorded.ts:24-37). `recordedTrace` turns those into a trace (:98), and `checkRecording` compares that trace with the written-down one (:382).

So the cheapest design is one converter: production spans in, `HeardEvent[]` out. Everything after that already exists: drawing on the tree and as a Flow, the "agrees with the written-down execution" pill, and the "not seen" reasons (RecordingScope.unseen, :58-62).

**Mapping spans onto blocks**
- **Function blocks.** Every function block has a pointer like `src/booking/book-seats.ts#bookSeats` (src/project/code.ts:31; examples/tickets/blocks/tickets/booking-api/book-seats/block.json:3). A span whose `code.file.path` ends with that file and whose `code.function.name` ends with that function is that block.
  - Hurdle: the spec wants `code.file.path` to be absolute and `code.function.name` fully qualified. A Node app also usually runs compiled `dist/*.js`, so matching needs the path normalised and source maps.
  - Bigger problem: the stock auto-instrumentation does not set `code.*` at all. I checked the Express and Flask instrumentation source and neither sets it. In practice these attributes only appear where someone adds them by hand.
- **Database blocks.** A database block lists its tables in `exposes` (tickets-db/block.json: `events`, `bookings`). Auto-instrumentation will rarely say which table, though: the Postgres (`pg`) instrumentation deliberately does not emit `db.collection.name`. Getting the table back means parsing `db.query.text`, which the spec advises against.
- **A better route for code held to a contract.** All of its store access goes through `caps`, which the app builds at one seam (examples/tickets/src/server.ts:38, :71, :82-84).
  - Fragmentor could generate a small preload: `--require`/`--import` in Node, a startup hook in Python. It would wrap each bound block's export and each Store/Queue method, just as the harness does.
  - Each wrapper would set `fragmentor.block`, `fragmentor.target` and the `code.*` attributes. OpenTelemetry's naming rules allow an application-name prefix like `fragmentor.`.
  - Then the mapping is exact, with no guessing.
  - Limits:
    - ESM support in OpenTelemetry JS is still experimental (loader hook plus import-in-the-middle).
    - Calls between two functions in the same file are not seen, the same blind spot recordings already have (recorded.ts:238-242).
    - It must stay a separate opt-in file. Contracts are types-only by design so they never touch the buyer's build (STATUS.md:30).
- **The trigger.** There is no HTTP-route field on an operation. Instead, the first matched function span is the block that answers an operation (booking-api `exposes.bookSeats.block = "book-seats"`), so the trigger is that operation.
- **Unmatched spans** (middleware, Redis, outgoing HTTP calls) become "could not see", or are folded into the nearest matched parent.
- **Queues.** Producer and consumer spans map to `send`/`deliver` via `messaging.destination.name`. Messaging conventions are still in Development, and batch consumers connect to producers through span links, not as parents.
- **Payloads.** Auto-instrumentation never captures function inputs or outputs, or HTTP bodies. Only the generated wrapper can. Span attributes may now be maps and arrays (spec Stable). JS support for that merged to main on 2026-09-28, but its release is unconfirmed. Span events are being deprecated. So payloads should be recorded as JSON-string attributes, size-capped as the harness already does.

**Storage without a database server**
- Plain files are enough. Two ready-made writers produce OTLP JSON Lines (one export batch per line):
  - The OpenTelemetry Collector's file exporter, with rotation (alpha).
  - Python's `opentelemetry-exporter-otlp-json-file` (0.66b0, beta).
- I found no official file exporter for Node. A custom exporter would be about 30 lines, or the Collector can do it.
- `node:sqlite` works inside Fragmentor's Electron. I ran this: Electron 44.3.0 / Node 24.20.0 ran an in-memory query on SQLite 3.53.4, with no added dependency. DuckDB can read globs of NDJSON files directly, but it would be a native dependency.
- Captured runs must never be committed. They belong in a git-ignored folder or the app profile, the way the Changes bookmark already lives in the app profile (STATUS.md:10).
- Pulling from a tracing system the team may already run, by trace id or by search:
  - **Jaeger v2:** `/api/v3/traces/{id}` and `/api/v3/traces?query.service_name=…`. The older `/api/traces/{id}` is internal and undocumented.
  - **Grafana Tempo:** `/api/traces/<id>` and `/api/v2/traces/<id>` return roughly OTLP JSON, and `/api/search` takes TraceQL.
  - **Datadog:** `GET /api/v2/trace/{trace_id}` is a preview, limited to 60 requests per minute. Retention is 15 days (custom filters) or 30 days (default filter).
  - **Honeycomb:** its Query Data API is Enterprise-only and returns aggregates. Its MCP server has `get_trace`.

**Live view**
- An OTLP/HTTP receiver means a `node:http` listener in Electron's main process. The renderer's security policy has no `connect-src` (app/renderer/index.html:7), so the window itself cannot fetch.
- It should listen on a port other than 4318, which Jaeger and the Collector already take.
- JSON (`application/json`) is easy to read. Protobuf (`application/x-protobuf`) needs a decoder, and protobuf is the default for Python and for the Node SDK. The app can switch with `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`; Python needs an extra beta package for that.
- Timing:
  - A span is sent only after it ends, so the root span arrives last.
  - The SDK batches spans and sends every 5 seconds by default.
  - Tail sampling holds spans for 30 seconds by default before deciding what to keep.
  - With ratio (head) sampling, a particular customer's run may simply not be there.
- For production, poll the tracing backend's search or tail the Collector's file. Either way, "live" means seconds to tens of seconds behind.

**Privacy**
- Payload capture puts customer data in the trace.
- Scrubbing at the Collector: the redaction processor (allowlist of keys plus regex masking), the attributes processor (delete/hash) and the transform processor. All three are beta. OpenTelemetry warns that hashing predictable ids does not anonymise them.
- Defaults that already help: query text is collected only when parameterised or sanitised, query parameter values are off by default, headers are opt-in, and known URL secrets are redacted.
- Fragmentor-side rules needed: payload capture off by default; a per-port "sensitive" mark, since Fragmentor knows every port's type; captured runs left out of Export, which today holds only agent-written executions (STATUS.md:12); and a retention limit.
- Scope tension: PROJECT.md:202 and :227 say local only, no server and no hosted service, and :229 puts "deploying or operating the software Fragmentor builds" out of scope. Reading a file or a team's existing backend keeps Fragmentor local. Shipping a collector does not.

**Effort and risks**
- Converter from OTLP JSON to `HeardEvent`, plus tests: small, a few hundred lines.
- A third trace source label and "Open trace file…": small, but every new snapshot field must be classified for the diff and export (STATUS.md:35, :40).
- Generated preload wrappers for TypeScript (CJS first) and Python: medium.
- Protobuf receiver and live drawing: medium to large.
- Pulling from backends: medium per vendor.
- Main risks: ESM wrapping, compiled-to-source path mapping, sampling gaps, and customer data landing on laptops.

**Smallest useful first slice.** File › Open trace… reads an OTLP JSON Lines file from a local run of the person's own app (Python json-file exporter, or the Collector's file exporter). It maps spans to blocks by `fragmentor.block`, otherwise by `code.*` matched to pointers. It feeds the result through `recordedTrace` and `checkRecording`, keeps it in memory only, and shows it on the tree and as a Flow. Prove it on `examples/tickets` run under a generated CJS preload. No server, receiver or dependency is needed.

**Claims (source, confidence)**
1. `code.*` became stable in semconv v1.33.0; `code.function`, `code.filepath`, `code.lineno`, `code.column` and `code.namespace` were replaced by `code.function.name`, `code.file.path`, `code.line.number` and `code.column.number`; opt-in via `OTEL_SEMCONV_STABILITY_OPT_IN=code|code/dup`. https://opentelemetry.io/docs/specs/semconv/non-normative/code-attrs-migration/ , https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/ (high)
2. Database spans are Stable: `db.system.name` required; `db.collection.name` and `db.operation.name` conditionally required; `db.query.text` recommended, collected only parameterised or sanitised; `db.query.parameter.*` off by default. https://opentelemetry.io/docs/specs/semconv/database/database-spans/ (high)
3. The `pg` instrumentation emits `db.system.name`, `db.query.text` and `db.operation.name` but not `db.collection.name`. https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/packages/instrumentation-pg/README.md (high)
4. Messaging conventions are in Development; operation types are create/send/receive/process/settle; batches use span links. https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/ (high)
5. The Express and Flask instrumentations set no `code.*` attributes and capture no bodies. https://raw.githubusercontent.com/open-telemetry/opentelemetry-js-contrib/main/packages/instrumentation-express/src/instrumentation.ts , https://raw.githubusercontent.com/open-telemetry/opentelemetry-python-contrib/main/instrumentation/opentelemetry-instrumentation-flask/src/opentelemetry/instrumentation/flask/__init__.py (high for these two; medium that this holds generally)
6. auto-instrumentations-node 0.80.0 covers http, undici, express, pg, mysql2, mongodb, ioredis, kafkajs, amqplib and others; fs is off by default. https://raw.githubusercontent.com/open-telemetry/opentelemetry-js-contrib/main/packages/auto-instrumentations-node/package.json (high)
7. ESM instrumentation in JS is experimental and needs `--experimental-loader` / import-in-the-middle. https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md (high)
8. OTLP/HTTP is port 4318 at `/v1/traces`, protobuf or JSON by Content-Type; JSON uses hex ids, integer enums and 64-bit integers as strings. https://opentelemetry.io/docs/specs/otlp/ (high)
9. Node SDK default protocol is http/protobuf; `exporter-trace-otlp-http` sends JSON. https://opentelemetry.io/docs/specs/otel/protocol/exporter/ , https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/exporter-trace-otlp-http/README.md (medium-high)
10. Python has OTLP JSON-over-HTTP and JSON-file exporters, both 0.66b0 beta (2026-09-25). https://pypi.org/project/opentelemetry-exporter-otlp-json-file/ , https://pypi.org/project/opentelemetry-exporter-otlp-json-http/ (high)
11. Collector file exporter: alpha; JSON lines or length-prefixed proto; rotation by size (100 MB default), age and backup count; zstd. The otlp_json_file receiver reads it back. https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/fileexporter/README.md , https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/otlpjsonfilereceiver/README.md (high)
12. Jaeger v2 serves `/api/v3/traces/{id}` and search; `/api/traces` is internal. https://www.jaegertracing.io/docs/latest/architecture/apis/ , https://github.com/briancaffey/hermes-otel/issues/245 (medium)
13. Tempo: `/api/traces/<id>`, `/api/v2/traces/<id>`, `/api/search` with TraceQL. https://grafana.com/docs/tempo/latest/api_docs/ (high)
14. Datadog `GET /api/v2/trace/{trace_id}` is a preview at 60 requests/min; retention 15 or 30 days. https://docs.datadoghq.com/api/latest/apm-trace/get-a-trace-by-id/ , https://docs.datadoghq.com/tracing/trace_pipeline/trace_retention/ (high)
15. Honeycomb's Query Data API is Enterprise-only and returns aggregates; its MCP server has `get_trace`. https://changelog.honeycomb.io/query-data-api-(enterprise)-197131 , https://docs.honeycomb.io/integrations/mcp/tools (medium)
16. Batch processor sends every 5000 ms by default; default sampler is parentbased_always_on; attribute value length unlimited by default. https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/ (high)
17. Tail sampling: beta, `decision_wait` 30 s, all spans of a trace must reach one collector. https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/tailsamplingprocessor/README.md (high)
18. Redaction, attributes and transform processors are beta for traces; hashing predictable ids is weak. https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md , https://opentelemetry.io/docs/security/handling-sensitive-data/ (high)
19. HTTP conventions redact known URL secrets, make headers opt-in, and record no bodies. https://opentelemetry.io/docs/specs/semconv/http/http-spans/ (high)
20. Map and array attribute values are allowed on spans; JS support merged 2026-09-28. https://opentelemetry.io/docs/specs/otel/common/ , https://github.com/open-telemetry/opentelemetry-js/pull/6780 (medium-high)
21. The span events API is being deprecated in favour of log-based events; existing data stays valid. https://opentelemetry.io/blog/2026/deprecating-span-events/ (high)
22. `node:sqlite` is unflagged since Node 22.13 and a release candidate since 25.7; it works in Electron 44.3.0 (run here). https://nodejs.org/api/sqlite.html (high)
23. DuckDB `read_json` reads newline-delimited JSON over globs. https://duckdb.org/docs/current/data/json/loading_json (high)
24. Application-specific attribute prefixes are allowed; borrowing OpenTelemetry's own namespaces is not recommended. https://opentelemetry.io/docs/specs/semconv/general/naming/ (high)

# VERDICT

**(a) Claims refuted or corrected**

1. **"Everything after the converter already exists: the 'agrees with the written-down execution' pill" is overstated.**
   - `checkRecording` needs a `WrittenExecution` (src/model/recorded.ts:382-394). Its step check compares each written step's `payload` and `response` (recorded.ts:498-523).
   - A customer's run uses different data from any execution the agent wrote. Matched against one, it would come out as "not seen" or contradicted, and the red pill would be misleading.
   - The pill only makes sense if a captured run is first turned into its own execution.
2. **"A third trace source label … small" understates the UI work.**
   - A recording is keyed by execution id and is dropped when that execution's trigger or starting rows change (app/renderer/state.ts:329-335).
   - The bar picks an execution and then toggles between at most one written and one recorded trace (app/renderer/execution.ts:179-185).
   - The window hard-codes the trigger of a recorded trace as "Fragmentor, from outside the system" (execution.ts:751-752).
   - Captured runs need their own list or picker and new wording for the trigger. That is new UI, not a label.
3. **`recordedTrace` needs a `HeardOutcome`, meaning what every store held when the run ended** (recorded.ts:98, 180-183). Production cannot supply that. The trace's `state` would be empty, and every expectation about end state would have to be set aside.
4. **"Protobuf is the default for Python" is wrong for the usual Python setup.** `opentelemetry-distro` defaults `OTEL_EXPORTER_OTLP_PROTOCOL` to `grpc` (https://raw.githubusercontent.com/open-telemetry/opentelemetry-python-contrib/main/opentelemetry-distro/src/opentelemetry/distro/__init__.py). That is gRPC on port 4317, so a `node:http` OTLP/HTTP listener receives nothing from a default Python app. The Node SDK default really is `http/protobuf` (https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/opentelemetry-sdk-node/README.md).
5. **"The spec wants `code.file.path` to be absolute" is too strong.** The definition only says "preferably an absolute file path" (https://opentelemetry.io/docs/specs/semconv/registry/attributes/code/). `code.function.name` being fully qualified is correct.
6. **Datadog retention is misread.** Custom retention filters keep spans for 15 days. The 30 days applies only to the Intelligent filter's diversity sample: one span per environment, service, operation and resource combination, plus high-latency spans (https://docs.datadoghq.com/tracing/trace_pipeline/trace_retention/). A particular customer's run survives only if a custom filter indexed it.
7. **Tempo truncates large attributes.** `max_attribute_bytes` defaults to 2048 and longer values are cut before storage (https://grafana.com/docs/tempo/latest/configuration/). The report's plan to carry payloads as JSON-string attributes therefore loses data above 2 KB when the trace is pulled from Tempo.
8. **`node:sqlite` status.** Release candidate since 25.7 is true on the current line, but the 24.x line also made it a release candidate in v24.15.0 (https://nodejs.org/docs/latest-v24.x/api/sqlite.html). Electron 44's Node 24.20 therefore already has release-candidate status, which strengthens the report's claim. I re-ran it: `{"node":"24.20.0","electron":"44.3.0","sqlite":"3.53.4"}`, with no warning.
9. **Honeycomb's Query Data API** is beta as well as Enterprise-only (https://changelog.honeycomb.io/query-data-api-(enterprise)-197131). The MCP `get_trace` tool has a default rate limit of 50 calls per minute (https://docs.honeycomb.io/integrations/mcp/tools).
10. **Jaeger v3 search example.** `/api/v3/traces` search also takes `query.start_time_min` and `query.start_time_max` (https://github.com/jaegertracing/jaeger-idl/blob/main/proto/api_v3/query_service.proto). I believe they are required but did not confirm that wording.
11. **Map and array attribute values in JS.** PR #6780 merged on 2026-09-28 (confirmed). It keeps span-event and resource attributes to simple types and applies a 128-attribute count limit by default (https://github.com/open-telemetry/opentelemetry-js/pull/6780). No release containing it was confirmed.
12. **The `fragmentor.` prefix.** The naming guidance suggests a reverse-domain prefix for names that may be used outside one company, and an application-name prefix only for internal names. A tool's attributes appear in many companies' apps, so a reverse-domain prefix fits the guidance better (https://opentelemetry.io/docs/specs/semconv/general/naming/). This is minor.

**(b) Claims confirmed**

- Trace sources are only `declared` and `recorded` (src/model/trace.ts:145). Every execution file is loaded as `declared` (src/project/executions.ts:78). Recordings are kept in memory only (STATUS.md:33). Only code held to its contract is recorded (STATUS.md:8).
- The only OpenTelemetry reference in the repository is vitest's optional peer dependency (package-lock.json:1759, 1775).
- The harness:
  - imports `AsyncLocalStorage` at harness.cjs:23 and creates it at :190;
  - caps a recording at 2000 calls and store uses counted together (:174), and values at 200,000 characters (:176);
  - replaces exports with the `traced` wrapper (:274-298, :313-318).
- `HeardEvent` is defined at recorded.ts:24-37, and also has `paused` and `resumed` types. `RecordingScope.unseen` is at :58-62. The same-file blind spot is at :238-243.
- The tickets example:
  - Code pointers: code.ts:31; book-seats/block.json:3.
  - Caps seam: tickets/src/server.ts:38, :71, :82-84.
  - `exposes.bookSeats.block` and the tickets-db tables `events` and `bookings` are as stated.
- The window's security policy has no `connect-src` (app/renderer/index.html:7).
- Scope lines: PROJECT.md:202, :227, :229.
- `code.*` attributes became stable in semconv v1.33.0, with the old-to-new mapping and the `code` / `code/dup` opt-in values as stated.
- The `pg` instrumentation does not emit `db.collection.name`, for the reason the report gives. The spec says not to extract it from query text when queries can touch several tables.
- Neither the Express nor the Flask instrumentation sets `code.*` attributes or captures bodies.
- auto-instrumentations-node is at 0.80.0. ESM support needs `--experimental-loader` and import-in-the-middle.
- OTLP/HTTP is port 4318 at `/v1/traces`. In JSON, ids are hex, enums are integers and 64-bit integers are decimal strings.
- Batch span processor 5000 ms, `parentbased_always_on` sampler and unlimited attribute value length are the defaults.
- Tail sampling is beta, waits 30 s by default, and needs all of a trace's spans on one Collector.
- The Collector file exporter is alpha, with 100 MB rotation, 100 backups and zstd.
- Redaction (beta for traces) and transform (beta) processors. Hashing predictable ids is weak.
- HTTP conventions redact known URL secrets and make headers opt-in.
- Messaging conventions are still in Development, and batch consumers connect to producers through span links.
- The Python json-file and json-http exporters are 0.66b0 beta, released 2026-09-25. I found no official Node file exporter.
- The span events API is being deprecated, and existing span-event data stays valid in OTLP.
- Datadog's trace-by-id endpoint is a preview limited to 60 requests per minute. Tempo's endpoints are as stated. Jaeger's `/api/*` is "intentionally undocumented".

**(c) What the report missed or weighted wrongly**

1. **The first slice proves the wrong thing.**
   - STATUS.md:8 explains why: Record already covers code held to its contract, and captured production runs are proposed for code that is only drawn.
   - `examples/tickets` is entirely code held to its contract, which Record already shows. A tickets slice demonstrates little that is new.
   - The hard case is drawn code, such as messenger or a rebuilt json-server. It has no caps seam, so store access can only be inferred from database spans, which the report itself calls weak.
   - Pointers can also name a method (`file#Class.method`) or a whole file, and neither can be wrapped by replacing an export (STATUS.md:37).
2. **`examples/tickets` cannot run as an application.**
   - It has no package.json and no tsconfig.
   - `src/server.ts` only exports `handle()` and never listens.
   - Its imports use `.js` suffixes, which suggests ESM output rather than the "CJS first" the slice assumes.
   - Someone would have to write an entry point and a build first.
3. **Bundled deployments defeat wrapping.** esbuild or webpack bundles, common in serverless, inline the modules, leaving no exports to replace. The report only covers compiled `dist/` files and ESM.
4. **Version skew is not addressed.** Production runs a deployed commit, while the tree reflects the current files. Blocks and pointers may have moved since. Captured runs should carry the deployed revision (for example `service.version`) and be drawn on `projectAt` that commit (STATUS.md:40). Otherwise spans get mapped onto the wrong blocks.
5. **A cheaper design is missing: capture inputs, then replay.**
   - Capture only the trigger payload and the rows each store read returned, and turn them into an `executions/*.json` with that payload and those rows as `given`.
   - The existing Record and the whole UI then work unchanged, but only for code held to its contract.
   - The cost: the clock and randomness are not detected (STATUS.md:109).
   - Execution files are committed with the project, so customer data would end up in the repository.
6. **`db.query.summary` is not mentioned.** It is a Recommended attribute, and its spec format is `{operation} {target}` (https://opentelemetry.io/docs/specs/semconv/database/database-spans/), which would give the table without parsing query text. The pg README does not list it, so this is limited help today.
7. **Live view.**
   - The Collector file exporter flushes every 1 s by default, and a simple (non-batching) span processor exports each span as it ends.
   - For local "live", tailing a file with Fragmentor's existing watcher may be simpler than running a receiver.
   - Production live remains a matter of polling a backend.