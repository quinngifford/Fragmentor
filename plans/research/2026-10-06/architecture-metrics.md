# REPORT

**Bottom line**
- Fragmentor can already work out the coupling-family metrics from what it holds: fan-in/fan-out, instability, dependency direction, cycles, how many blocks share a database entry, and a rough architecture quantum. Rules are already fitness functions, and "Flag → note to agent" already does the "mark it for the agent" step (STATUS.md:54-55).
- Cyclomatic complexity and component size need one more pass over each block's code with the TypeScript compiler or Python's `ast`. Of all the metrics here, these two have the best-supported thresholds.
- On a project the size of `examples/tickets` (13 blocks, about 200 lines), the numbers are small whole numbers and instability mostly repeats each block's role. A red-to-green scale would be noise at this size. Counts, outliers and named weak points are the useful output.
- Abstractness and distance from the main sequence do not fit how Fragmentor maps blocks to code.
- Performance beyond counting calls needs production or load data. Run timings today are one wall-clock number per run against stand-in stores.

**Metrics, sorted**

| Metric | Plain definition | Data | Good range? | Per block in Fragmentor |
|---|---|---|---|---|
| **1. Computable now from the diagram (access lines + reach edges)** |||||
| Afferent (Ca) / efferent (Ce) coupling | Ca: how many outside things depend on it. Ce: how many outside things it depends on | Dependency graph | None universal | Count distinct blocks outside the subtree, using access lines (block.ts:172) plus reach edges (reach.ts:40-49) |
| Instability I = Ce/(Ca+Ce) | 0 = everything leans on it, 1 = it leans on everything | Ca, Ce | No target value. Only the direction matters: depend toward lower I | Per block, plus a count of edges where I(target) > I(source) |
| Dependency cycles | A depends on B, which depends back on A | Graph | Zero is widely accepted, and the book uses it as a fitness-function example | Not implemented: no cycle code found in src/ |
| Connascence degree and locality (static: name, type) | How many blocks must change together, and how far apart they sit in the tree | Contracts, exposed entries, capability names | Rule of thumb only: weaker forms and closer distance are better | Blocks touching each `resource.entry`. Distance via the deepest shared block (reach.ts:61-66) |
| Structural cohesion of a group (LCOM4-style, adapted) | Does a group's content form one connected cluster or several? | Child blocks, their calls and shared entries | LCOM4 = 1 is the usual goal. Adapting it to blocks is my own extension, not from the book | Count connected clusters among children |
| Architecture quantum (approximate) | Smallest unit that deploys on its own, tied together by synchronous calls and shared data | Roles, call vs send, shared databases | A description, not a score | Group service/client blocks by synchronous `calls` and shared database |
| Fitness functions | Any automated check of an architecture property | Rules | Set by the person | Already exist: `never` / `only` rules (rules.ts:1-12, project/rules.ts:12-26) |
| **2. Computable with more code parsing** |||||
| Cyclomatic complexity | Number of independent paths through a function | Function's syntax tree from the code pointer | **Most established.** McCabe/NIST limit is 10, with 15 used successfully. The book's authors prefer under 5 | Walk the pointed function (code.ts:29-51) with `typescript` (package.json:24) or Python `ast` |
| Component size / % of codebase | Statements in a component, share of the whole, distance from the average | Statements per pointer | Heuristic (The Hard Parts): flag over ~10% or 1-2+ standard deviations from the mean | Count statements per pointer. Also report code under no block (`unpointed`, reach.ts:57) |
| Classic LCOM | How many methods of a class share no fields | Classes | Variants disagree (LCOM1 is widely criticized) | Only for blocks that point at a class. Rare |
| Python reach | Same edges as TypeScript | Imports | n/a | Today only TypeScript reads reach (typescript.ts:140). Python has declared access only |
| **3. Needs production or run data** |||||
| Dynamic connascence (execution order, timing, value, identity) | Agreement that only exists at run time | Real traces with times | Rule of thumb only | Recorded traces give order and shared writes, but have no timestamps (trace.ts:68-99) |
| Weighted coupling | Coupling counted by how often calls actually happen | Call frequency | n/a | Needs real traffic |
| Latency p50/p95/p99, throughput, error rate | How fast the system answers, measured statistically | Production or load tests | Set per system as budgets | Not available |
| Scalability, elasticity, availability | Behaviour under growing load, sudden bursts, and failure | Load or chaos testing, monitoring | Set per system | Not available |
| Deployability, test coverage | How safely and quickly it ships, how much code tests exercise | CI history, instrumented runs | Set per team | Not available |
| **4. Not meaningful for Fragmentor as built** |||||
| Abstractness A, distance from main sequence D = abs(A+I-1), zone of pain / zone of uselessness | Balance of how abstract a component is against how stable it is | Count of interfaces and abstract classes | Contested; little empirical validation | Each block points at one function, so A is about constant. Every database scores A=0, I=0, D=1 (zone of pain). That is technically true (Martin himself puts database schemas there) but gives nothing to act on |
| Style star ratings | The book's qualitative rating of each architecture style | Opinion | n/a | Not a measurement |
| Functional cohesion score | Whether a block has one clear purpose | Meaning | n/a | An agent can judge it, but it can't be computed |

**Worked numbers: `examples/tickets`**

I wrote a read-only script, `.../scratchpad/research/coupling.cjs`, that resolves access lines outward and counts edges crossing each subtree. I hand-added reach edges from the imports.

| Block | Role | Ca | Ce | I (declared only → declared + reach) |
|---|---|---|---|---|
| tickets-db | database | 5 | 0 | 0 |
| outbox | queue | 3 | 0 | 0 |
| booking-api | service | 1 | 2 | 0.67 |
| book-seats | function | 0 | 2 → 4 | 1.0 |
| reserve | function | 0 → 1 | 2 | 1.0 → 0.67 |
| find-event | function | 0 → 2 | 1 | 1.0 → 0.33 |
| pricing | group | 0 → 2 | 0 | – → 0 |
| box-office | client | 0 | 1 | 1.0 |
| reminders (planned) | service | 0 | 2 | 1.0 |

What this shows:
- **Declared access alone misses all function-to-function coupling.** Access lines name only architecture blocks. `pricing` looks unused (Ca=0) until reach edges are added (Ca=2).
- **Declared Ce is inflated.** A caller must hold every capability its callees need (block.ts:33-35). So `book-seats` declares that it reads `tickets-db.events`, but its own code never reads it. Only `find-event` does (book-seats.ts:17, find-event.ts:5). Reach edges, not access lines, should drive Ce.
- **Instability mostly repeats the role.** Stores come out at 0 and entry points at 1. There are no edges pointing toward a less stable block and no cycles.
- **The real signal is the shared rows.** `tickets-db.events` and `tickets-db.bookings` are each touched by 4 blocks, and `find-event` (Ca=2) is a shared helper. A row-shape change in `events` ripples to 4 blocks.
- **Size would surface unowned code.** `src/server.ts` is 85 of 202 lines (42%) and no block points at it. It is glue.

`examples/messenger` (22 blocks, declared access only):
- `infrastructure` has Ca=7 and `database` has Ca=6.
- The three `client/ui` children share no edges with each other. The adapted cohesion count is 3, which flags `ui` as a grouping by technical layer rather than by feature.
- One approximate quantum in each example: client, API and workers are all bound by one shared database. The outbox in tickets is asynchronous, but the shared database still holds everything together.

**Performance: what exists today**
- Each run reports `durationMs`: wall time minus time paused at breakpoints (run.ts:80, 239-270). Saved test cases carry one too (run.ts:98). The bench and watch screens show it (app/renderer/bench.ts:273, 337; app/renderer/watch.ts:485).
- These are single samples against seeded in-memory stand-in stores (run.ts:211-221), with a 15-second default timeout (run.ts:331). There is no database or network latency.
- Recorded traces have no per-event timestamps (trace.ts:68-99) and live in memory only (STATUS.md:8).
- **Possible now:** per execution, count calls, store round trips, fan-out, and the depth of the synchronous call chain. These are proxies for latency. For example, `book-seats` calls `priceSeat` once per seat (book-seats.ts:23-25). The recorder already folds repeated calls together (recorded.ts:578-582).
- **Needs production or load data:** percentile latency, throughput, scalability, elasticity. The book says to measure performance statistically rather than with single runs, which Fragmentor's runs cannot do.

**Claims**

| Claim | Source | Confidence |
|---|---|---|
| The book's modularity chapter covers cohesion (including LCOM), Ca/Ce, A, I, D and connascence | https://danlebrero.com/2021/11/17/fundamentals-of-software-architecture-summary/ | High |
| I = Ce/(Ca+Ce); D = abs(A+I-1); introduced by Robert Martin | https://en.wikipedia.org/wiki/Software_package_metrics | High |
| Zone of pain = concrete and stable; zone of uselessness = abstract and unstable | https://www.hanselman.com/blog/exiting-the-zone-of-pain-static-analysis-with-ndepend | High |
| Martin calls database schemas volatile, concrete and heavily depended on, so they sit in the zone of pain | https://github.com/aj03794/clean-architecture | Medium |
| Martin's metrics have little theoretical or empirical validation and no sharp boundaries | https://www.researchgate.net/publication/31598248_A_Validation_of_Martin's_Metric | Medium |
| LCOM1 (Chidamber and Kemerer) is criticized; LCOM4 counts connected clusters | https://www.aivosto.com/project/help/pm-oo-cohesion.html | High |
| Connascence: static forms are name, type, meaning, position, algorithm; dynamic forms are execution, timing, value, identity; judged by strength, locality, degree | https://connascence.io/ | High |
| McCabe/NIST limit is 10, with 15 acceptable when justified | https://www.nist.gov/publications/structured-testing-testing-methodology-using-cyclomatic-complexity-metric | High |
| The book's authors prefer cyclomatic complexity under 5 (industry: under 10) | https://bagerbach.com/books/fundamentals-of-software-architecture/ | Medium (secondary source) |
| Component size measured in statements; flag over ~10% of codebase or outliers by standard deviation (The Hard Parts) | https://danlebrero.com/2022/03/30/software-architecture-the-hard-parts-book-summary/ | Medium |
| Quantum = independently deployable, high functional cohesion, synchronous connascence; The Hard Parts adds high static coupling | https://github.com/pkardas/notes/blob/master/books/fundamentals-of-architecture.md ; https://medium.com/@ismailbayram.ce/my-book-notes-software-architecture-the-hard-parts-part-1-32856f1c37d3 | High |
| Fitness function = objective integrity check of an architecture property | https://www.thoughtworks.com/radar/techniques/architectural-fitness-function | High |
| The book splits measures into operational, structural and process; performance should be measured statistically | https://github.com/pkardas/notes/blob/master/books/fundamentals-of-architecture.md | Medium |
| The book warns that characteristics are vague and context decides | https://danlebrero.com/2021/11/17/fundamentals-of-software-architecture-summary/ | High |
| The 2nd edition (2025) adds chapters on modular monoliths, patterns and intersections, and revises the laws. I found no change to the metric set | https://nidly.substack.com/p/book-review-fundamentals-of-software | Medium-low |
| Access lines name only architecture blocks; function-to-function edges come only from reach | src/model/block.ts:94-110, src/project/reach.ts:13-38, examples/tickets block.json files | High |
| Callers must hold their callees' capabilities, which inflates declared Ce | src/model/block.ts:33-35 | High |
| Python has no reach reader | src/lang/typescript.ts:140, src/lang/pack.ts:148-149 | High |
| Traces carry no timing; run time is one wall-clock number | src/model/trace.ts:68-99, src/run/run.ts:239-270 | High |

Scratch script: `C:\Users\quinn\AppData\Local\Temp\claude\C--Users-quinn-OneDrive-CS-Projects-Fragmentor\4607a7c1-ebc6-4de4-9e7e-ba153fc1add2\scratchpad\research\coupling.cjs`

# VERDICT

**(a) Claims refuted or corrected**

1. **"Recorded traces have no timestamps", and "timing" (dynamic connascence) needs production data.** Partly wrong.
   - Both harnesses already stamp every call, return, throw and store use with `at`, in milliseconds since the run started:
     - src/run/harness.cjs:191, 215, 279-283
     - src/run/harness.py:230-245, 300-315
     - the RunEvent type, src/run/typescript.ts:84-93
   - The stamp is dropped at `HeardEvent` (src/model/recorded.ts:24-36). It never reaches `Trace` (trace.ts:68-110).
   - So per-call duration inside a sandbox run is a small change, not missing data.
   - Caveats:
     - The resolution is `Date.now`.
     - Breakpoint holds are subtracted only from the total (run.ts:225-237, 270), not from each `at`.
     - The stores are in-memory Maps (harness.cjs:51-100), so there is no I/O latency.

2. **"The recorder already folds repeated calls together (recorded.ts:578-582)."** Wrong.
   - Those lines are `unwritten()`. It compares the written-down trace with the recording, and lets one written step stand for several recorded calls.
   - The recording itself keeps every call. After 2000 calls plus store uses it stops recording and marks the run `truncated` (harness.cjs:174, 197-199, 337; run.ts:83-84).
   - Any call-count metric has to handle that cap.

3. **The tickets worked table used hand-added reach edges and missed the glue code.** I ran Fragmentor's own reader (`readProjectReach`) on the scratch copy (scratchpad/research/edges-only.mts). It gives 6 edges, including box-office→book-seats and box-office→cancel-booking. Those pass through `src/server.ts`, which reach.ts:31-34 follows as glue (src/box-office.ts:1 imports `handle`).
   - book-seats: Ca is 1, not 0, so I = 0.80, not 1.0.
   - cancel-booking: Ca = 1, I = 0.75.
   - box-office: Ce = 3 if you count distinct blocks.
   - The conclusion still holds: no edge points toward a less stable block, and there are no mutual pairs.

4. **"Report code under no block (`unpointed`) … `src/server.ts` is 42%."** `unpointed` comes back `[]` for tickets. server.ts is reached as glue, so it is not "unpointed" (reach.ts:56-57). A size metric would need its own count of code under no pointer. Also, 85/202 counts lines including comments. The Hard Parts metric counts statements.

5. **"Reach edges, not access lines, should drive Ce."** In contract-bound code this would delete every store dependency.
   - Bound code reaches stores through injected `caps`, not through imports. The kernel's tickets reach has zero edges to tickets-db or outbox.
   - The right combination is:
     - reach for code calling code;
     - declared access for stores, minus pass-through capabilities.
   - Pass-through can be detected by checking whether the block's own code uses `caps.<port>`. For example, find-event.ts:5 does; book-seats.ts does not.
   - Drawn code is the reverse: messenger reaches its database by importing `src/infrastructure/db.ts`, so reach does see it.
   - The report's "real signal" bullet ("events touched by 4 blocks") counts the declared access the report itself calls inflated. In code, `events` is touched by find-event, reserve (reserve.ts:15) and cancel-booking (cancel-booking.ts:14). book-seats depends on it only through the Event type.

6. **"Each block points at one function, so A is about constant; every database scores A=0."** The premise is false for drawn projects.
   - In messenger, component, service, client, database and queue blocks point at whole files or folders: `src/api`, `src/client`, `src/infrastructure/db.ts` and so on (examples/messenger blocks/**/block.json).
   - A pointer may name a file, a folder, a class or a method (block.ts:189-195).
   - So size and complexity per block must add up over nested, overlapping pointers, giving each piece of code to its deepest owner as reach.ts:23-38 does.
   - In tickets, the database blocks have no code, so A is 0/0 (undefined), not 0.

7. **Messenger was described as "declared access only", but its reach is readable** (`systemsRead app:true`, 18 code edges). The report missed the real findings:
   - `client/state → api/router`: the client imports the server router in-process.
   - `workers/deliver-notification → client/state`.
   - The ui children each depend on `client/state`. The "cohesion 3 for ui" figure holds, but it is the normal store-centred client shape, not clearly a layering smell.

8. **"Martin's metrics have little theoretical or empirical validation."** This overstates the source. It is one 2009 symposium paper (Hyrynsalmi & Leppänen), which finds a theoretical weakness in Martin's cohesion definition and evaluates five open-source apps. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2281686

**(b) Confirmed**

- Access may target only architecture blocks. Access to a function block is an error (src/project/project.ts:679-683; block.ts:100-105).
- Callers must hold their callees' capabilities (block.ts:31-36).
- Python has no reach reader. `reach?` is optional (pack.ts:148-149), TypeScript sets it (typescript.ts:140), and src/lang/python.ts has none.
- No cycle detection exists in src/ or app/. project.ts:460-461 only caps route length "so a loop in the diagram cannot hang".
- Rules are the `never`/`only` dependency checks (src/model/rules.ts:1-28; src/project/rules.ts:12-28).
- A note can be left on a block, and a reported problem has Flag beside it (STATUS.md:54-55).
- `durationMs` is wall time minus breakpoint holds (run.ts:239-270). The default timeout is 15s (run.ts:331, 431). It is shown at bench.ts:273, 337 and watch.ts:485. Recordings live in memory only (STATUS.md:8).
- `typescript` is already a dependency (package.json:24). `holding()` returns the deepest shared block (reach.ts:62-68).
- Kernel numbers agree with the report: tickets-db Ca 5, outbox Ca 3, find-event Ca 2 / I 0.33, pricing Ca 2 only via reach; messenger database Ca 6.
- Cyclomatic complexity: McCabe's 10, with up to 15 used successfully (NIST text, quoted at https://learn.microsoft.com/en-us/archive/blogs/zainnab/code-metrics-cyclomatic-complexity). The book prefers under 5 (https://bagerbach.com/books/fundamentals-of-software-architecture/).
- Component size (Hard Parts) is counted in statements, flagged by % of the codebase and by standard deviations from the mean (https://danlebrero.com/2022/03/30/software-architecture-the-hard-parts-book-summary/).
- Connascence forms and the strength/degree/locality properties (https://connascence.io/).
- The quantum definitions, the operational/structural/process split, statistical performance models, and cycles and distance-from-main-sequence as fitness-function examples (bagerbach page above).
- The 2nd edition added chapters 20, 26 and 27 (https://nidly.substack.com/p/book-review-fundamentals-of-software). Nothing I found shows a change to the metric set, but I could not confirm it either way.

**(c) Missed or mis-weighted**

1. **Runs and recordings exist only for contract-bound code** (STATUS.md:8; snapshot `runnable`). Messenger and the real-codebase rebuilds are drawn code, so none of the run-based performance proxies apply to the projects the person cares most about. Static metrics are the only ones available everywhere.

2. **Reach edges never reach the window.** The snapshot carries only `reachNotChecked`, `reachRead`, `reachUnpointed` and rule results (snapshot.ts:527, 548, 568, 576). A dashboard needs the edges or computed metrics added, and every new snapshot field must be classified in snapshotFields.ts (STATUS.md:40).

3. **Bound and drawn code differ in how store coupling is seen** (point a5). Without handling this, one metric would mean different things in different projects.

4. **"Red-to-green is noise" is true for coupling counts but not for cyclomatic complexity.** Complexity has published bands:
   - radon grades A (1-5) through F (41+): https://radon.readthedocs.io/en/latest/commandline.html
   - NIST 10/15, the book's under 5
   - ESLint's default maximum of 20: https://eslint.org/docs/latest/rules/complexity

   Tools count `&&`, `||`, `??` and switch cases differently, so the threshold must match the counting rule.

5. **Complexity can reuse parsers Fragmentor already runs.** src/check/rules.py already walks Python's `ast` with the project's interpreter (lines 14, 73, 160-171). typescriptReach.ts:4 already parses with `typescript`. No new dependency is needed. dependency-cruiser computes Ca/Ce/I and cycles off the shelf (https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md), but per file and folder, not per block.

6. **Git-history measures were left out, though they are the strongest way to find weak points and are computable now.**
   - Change frequency per block, crossed with complexity, gives "hotspots".
   - Co-change (blocks that change in the same commits) gives temporal coupling.
   - Source: https://codescene.io/docs/guides/technical/hotspots.html
   - Fragmentor already lists every commit that touched a block or its code (`blockVersions`, src/project/history.ts:681).

7. **The link to feature 1 is missing.** Latency percentiles, coupling weighted by call frequency, and timing connascence are exactly what captured production executions would supply. OpenTelemetry spans carry start and end times and a parent span ID (https://opentelemetry.io/docs/concepts/signals/traces/). STATUS.md:8 already lists capturing runs from the person's own application as proposed, not planned. The report treats these metrics as unavailable rather than as what feature 1 would deliver.

Scratch scripts I added: C:\Users\quinn\AppData\Local\Temp\claude\C--Users-quinn-OneDrive-CS-Projects-Fragmentor\4607a7c1-ebc6-4de4-9e7e-ba153fc1add2\scratchpad\research\edges-only.mts (prints reach edges). I also ran the existing reach-metrics.mts in the same folder on the tickets and messenger copies. No repository file was edited.