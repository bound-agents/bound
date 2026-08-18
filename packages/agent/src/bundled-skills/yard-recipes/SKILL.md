---
name: yard-recipes
description: Working recipes for the yard tool — scatter-gather orchestration, effect selection, partitioning doctrine, and the failure modes that waste runs.
allowed_tools: skill-read
---

# Yard Recipes

Yard executes a bounded JavaScript generator (`function* main(input)`) that
yields branded effects — `tool()`, `infer()`, `aux()`, `all()`, `sequence()` —
while corpus-scale intermediates stay inside the program. Read this before
writing a nontrivial program; the recipes here are the difference between a
run that covers the task and a run that samples it.

## Choosing the right effect

The unit of substantive work is an **agent**, not a raw tool call.

- `aux(name, instructions, options?)` — the normal unit of work. An aux agent
  runs a real tool loop: it can read, edit, run commands, and exercise
  judgment. Anything that is itself "a job" belongs in an aux errand.
- `infer(modelId, { prompt, input?, schema? })` — pure text-to-text. The
  invoked model has NO tools, no filesystem, and sees nothing beyond your
  prompt and input. Asking it to "inspect the repo" or "apply edits" fails
  structurally. Use it to structure and synthesize data already in hand —
  always with a `schema` when the result feeds another stage.
- `tool(name, args)` — glue. Enumeration up front (a listing, a search),
  verification at the end (a test run). If a program's core work is a chain
  of raw `tool()` calls, that work belongs inside an `aux()` errand instead.

## Passing data between stages

Effect results are ordinary JS values inside the program. Two rules:

1. **Never interpolate an object into a string.** The guest throws at the
   coercion site (`` `${someObject}` `` is always data loss — it would embed
   `[object Object]`). `JSON.stringify()` the value, or extract the fields
   you need.
2. **`infer()` takes structured data via `request.input`**, not via prompt
   interpolation. The prompt says what to do; `input` carries the data.

## Sizing: partition on the first attempt

A corpus-scale request ("clean up the codebase", "audit every handler")
deserves a partitioned plan from the start — not a hand-run survey in your
own loop first, and not two broad errands that sample the surface.

- A **partition** is the smallest unit one agent can exhaustively cover and
  verify: a directory or a batch of a few files. Not a group of packages.
- **Dozens of concurrent aux agents is the normal shape** for repo-wide
  work, not an escalation.
- Every errand gets an explicit scope and a concrete standard for what to
  change. The persona carries standing behavior (temperament, discipline);
  the instructions carry only the errand. If you are writing multi-kilobyte
  instructions re-teaching workflow, the roster is missing an identity —
  see the `aux-agents` skill.
- Return **per-partition outcomes** (files touched, items skipped and why)
  so coverage is checkable from the result. A blended summary hides
  unworked ground.
- Budget generously (`budget: { timeout_seconds, concurrency }`) rather
  than shrinking the plan to fit a default.

## Recipe: scatter-gather corpus change

Read-agents survey every partition; `infer()` structures the plan;
write-agents implement; reviewer agents gate acceptance; failures
re-dispatch once with the specific objections.

```js
function* main(input) {
  // Partitions via one glue tool() call.
  const listing = String(yield tool("boundless_bash", { command: "ls -d packages/*/" }));
  const pkgs = listing.match(/^packages\/[\w-]+(?=\/)/gm) ?? [];
  if (pkgs.length === 0) throw new Error("no partitions");

  // SCATTER: a read-agent surveys each partition. No edits yet.
  const surveys = yield all(
    pkgs.map((pkg) => aux("scout", `Survey ${pkg} for: ${input.goal}. List candidate files with reasons; make NO edits.`, { model: input.model })),
    { concurrency: 4 },
  );

  // GATHER: structure the free-text reports into per-partition work orders.
  const orders = yield infer(input.model, {
    prompt: `Turn each survey into a concrete work order for: ${input.goal}. No real candidates => skip=true.`,
    input: pkgs.map((pkg, i) => ({ pkg, survey: surveys[i] })),
    schema: { type: "array", items: {
      type: "object",
      properties: { pkg: { type: "string" }, skip: { type: "boolean" }, order: { type: "string" } },
      required: ["pkg", "skip", "order"],
    } },
  });

  // RE-SCATTER: a write-agent implements each order.
  let active = orders.filter((o) => !o.skip);
  yield all(
    active.map((o) => aux("implementer", `In ${o.pkg}, do exactly this, then report per-file outcomes: ${o.order}`, { model: input.model })),
    { concurrency: 4 },
  );

  // REVIEW GATE: reviewers inspect real diffs; failures re-dispatch once.
  const outcomes = [];
  for (let round = 0; active.length > 0; round++) {
    const reviews = yield all(
      active.map((o) => aux("reviewer", `Run git diff -- ${o.pkg} and judge whether the changes satisfy: ${o.order}. Name specific gaps.`, { model: input.model })),
      { concurrency: 4 },
    );
    const verdicts = yield infer(input.model, {
      prompt: "For each review, decide pass/fail and extract the objections.",
      input: active.map((o, i) => ({ pkg: o.pkg, review: reviews[i] })),
      schema: { type: "array", items: {
        type: "object",
        properties: { pass: { type: "boolean" }, objections: { type: "string" } },
        required: ["pass", "objections"],
      } },
    });
    const failed = [];
    active.forEach((o, i) => {
      if (!verdicts[i].pass && round === 0) failed.push({ ...o, objections: verdicts[i].objections });
      else outcomes.push({ pkg: o.pkg, pass: verdicts[i].pass, objections: verdicts[i].objections });
    });
    if (failed.length > 0) {
      yield all(
        failed.map((o) => aux("implementer", `Rework ${o.pkg} — the reviewer rejected it: ${o.objections}. Original order: ${o.order}`, { model: input.model })),
        { concurrency: 4 },
      );
    }
    active = failed;
  }
  return { partitions: pkgs.length, skipped: orders.filter((o) => o.skip).map((o) => o.pkg), outcomes };
}
```

The reviewer instruction names the acceptance criteria; the rework
instruction carries the reviewer's specific objections, not "try again".
One rework round is the default — unbounded loops burn the budget on a
partition that needs a human decision.

## Recipe: parallel specialist judgment, structured synthesis

```js
function* main(input) {
  const reviews = yield all([
    aux("pricing-skeptic", input.pricing_question, { model: input.model }),
    aux("reviewer", input.design_question, { model: input.model }),
  ], { concurrency: 2, errors: "settled" });

  const synthesis = yield infer(input.model, {
    prompt: "Synthesize a compact decision artifact. Preserve disagreements and name the next implementation slice.",
    input: reviews,
    schema: {
      type: "object",
      properties: {
        decision: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
        next_slice: { type: "string" },
      },
      required: ["decision", "risks", "next_slice"],
    },
  });
  return { reviews, synthesis };
}
```

`errors: "settled"` returns input-ordered `{ status, value | reason }`
entries so one failed specialist doesn't abort the panel.

## Recipe: locate → delegate → verify

When the change is small enough for one implementer but you still want the
program to gate it:

```js
function* main(input) {
  const hits = String(yield tool("boundless_search", { pattern: input.pattern, path: input.path }));
  if (!hits.includes(":")) throw new Error(`pattern not found: ${input.pattern}`);

  const report = yield aux("implementer", `Apply this change at the sites below, then run ${input.verify_command} and report per-file outcomes.\n\nChange: ${input.instruction}\n\nSites:\n${hits}`, { model: input.model });

  const check = String(yield tool("boundless_bash", { command: input.verify_command }));
  return { report, verified: check.includes("Exit code: 0") };
}
```

## Recipe: dynamic multi-round orchestration

The rounds do NOT need to be known when the program is written. Results are
ordinary values, so the next fan-out can be COMPUTED from the last one — an
`infer()` planning step between rounds turns the program into a dispatcher
that keeps working until the job is done, instead of a fixed pipeline that
ends after its last authored stage and hands control back to your loop.
Prefer this shape whenever you cannot enumerate every stage up front:
survey → plan → work → review → repair → release can be ONE program even
when the middle rounds depend on what the early rounds find.

```js
function* main(input) {
  const history = [];
  // Seed round: read-only survey of every area.
  let results = yield all(
    input.areas.map((a) => aux("scout", `Survey ${a} for: ${input.goal}. Make NO edits; report findings or say none.`, { model: input.model })),
    { concurrency: 6, errors: "settled" },
  );

  for (let round = 0; round < input.max_rounds; round++) {
    // PLAN: the dispatcher decides the next round from actual results.
    // infer() has no tools — it plans purely from the data handed to it,
    // which is exactly the discipline a dispatcher should have.
    const plan = yield infer(input.model, {
      prompt:
        `You dispatch aux errands toward: ${input.goal}. Decide the next round from the results. ` +
        "Rules: findings-free narration is MISSING coverage (re-dispatch that scope, smaller). " +
        "Route repairs to a write-shaped identity carrying the reviewer's objections verbatim. " +
        "Implementation rounds must precede a review round; nothing releases unreviewed. " +
        "When the work is complete and reviewed, return done=true with exactly one release errand.",
      input: { round, results, history },
      schema: { type: "object", properties: {
        done: { type: "boolean" },
        errands: { type: "array", items: { type: "object", properties: {
          identity: { type: "string" },
          instructions: { type: "string" },
        }, required: ["identity", "instructions"] } },
      }, required: ["done", "errands"] },
    });
    history.push({ round, decision: plan });
    if (plan.done && plan.errands.length === 0) break;

    results = yield all(
      plan.errands.map((e) => aux(e.identity, e.instructions, { model: input.model })),
      { concurrency: 4, errors: "settled" },
    );
    if (plan.done) break; // release round dispatched; stop after it lands
  }
  return { history };
}
```

The round cap is a budget guard, not a plan — the planner ends the run by
returning `done`, and the cap only stops a dispatcher that never converges.
Give the planner the standing rules (coverage skepticism, repair routing,
review-before-release) in its prompt: it makes those calls between every
round, which is precisely where live runs have historically dropped them.

## Failure modes that waste runs

- **`infer()` asked to act.** It has no tools. It will explain that it
  cannot inspect the repository, and the run completes having done nothing.
- **Object interpolated into instructions.** Throws at the coercion site
  (see "Passing data between stages"). Fix the interpolation, don't work
  around it.
- **Two broad errands over ten partitions each.** Both come back green, the
  summary reads complete, most of the tree went unexamined. Partition
  finely; return per-partition outcomes.
- **`background: true` on aux inside Yard** — rejected at dispatch. Yard
  invocations are synchronous; concurrency comes from `all()`.
- **Nested `tool("yard", ...)` with a `budget`** — rejected. Nested runs
  inherit the root deadline and concurrency unchanged.
- **Schema violation from `infer()`** — fails the effect; there is no hidden
  repair. Catch and retry explicitly if the stage is retryable.
- **A reviewer errand told to "fix it directly" or own the release.** That is
  role-forcing: the reviewer judges; repairs go to an implementer
  re-dispatched with the reviewer's specific objections. Observed live: a
  reviewer handed repair-and-release duties spent its whole budget and
  returned a bare apology.
- **A survey arm told to implement.** The scatter phase reads; the implement
  phase writes. An arm instructed to "implement fully" during the survey
  races the other arms' reads, and its work is discarded by the later
  implement stage anyway.
- **Release ownership split across arms.** "Commit and push if the
  implementer has not already done so" makes two agents responsible for one
  irreversible step. Exactly one errand owns commit/push; everyone else
  reports.
- **The program ends at the scatter.** Survey results are values in scope
  only inside the program. Returning them raw to your own loop and starting
  a second Yard discards the pipeline: the gather stage (schema-validated
  work orders) and the re-scatter must ride the SAME program. Observed
  live: 13 exhaustive package surveys (~186 KB of ranked candidates with
  exact files and symbols) returned to the orchestrator; the follow-up
  implementer was told to "independently inspect" instead, and repo-wide
  coverage collapsed to two fixes. The rule is about VALUES dying at the
  program boundary. A STAGED sequence of Yards — survey/implement, then
  review, then scoped repairs — can be legitimate because the pipeline
  artifact is the shared worktree (an uncommitted diff survives between
  runs; a survey report does not), but it is the FALLBACK, not the goal:
  every return to your loop hand-carries verdicts across the boundary,
  spends main-thread context on transfer, and offers one more chance to
  absorb the work yourself. When the later stages depend on earlier
  results, plan them INSIDE one program instead (see Recipe: dynamic
  multi-round orchestration). Reserve staged Yards for a genuine operator
  decision between stages.
- **Review after release.** The review gate holds work BEFORE the release
  errand fires; a reviewer inspecting an already-pushed commit can only fix
  forward. Sequence: implement (no commit) → review → rework if failed →
  one release errand ships the approved diff.
- **"Fulfilled" is not "reported."** An aux errand that runs out of budget
  mid-work returns its last progress note as its result, and `all()` marks
  it fulfilled. The gather stage must treat a findings-free narration ("I'm
  tracing X now…") as MISSING coverage — re-dispatch that scope with a
  smaller partition, or name it unexamined in the outcomes. Observed live:
  2 of 6 survey arms (covering the two largest packages) returned progress
  notes; synthesis emitted zero work orders for them and the audit silently
  lost those packages. Partition size is also a budget question: the
  single-package arms returned 17–45 KB reports while the multi-package
  arms ran out of room — an errand must FIT inside one aux run.
- **Repairs handed to the finder.** When a review surfaces defects, the
  rework goes to the write-shaped identity carrying the finder's
  objections — not back to the analyst who found them, however natural
  "fix what you found" feels. And when a repair errand fails, narrow it and
  re-dispatch; absorbing the implementation into your own loop discards
  the parallelism, context isolation, and reviewability you paid for.
- **Write-arms sharing a worktree.** A scatter whose arms implement
  directly merges scout and implementer: the gather/prioritization stage
  disappears (no cross-scope synthesis to reject weak candidates early),
  N concurrent arms edit one worktree at once, and repairs have no
  distinct write identity to route to — the finder IS the writer. If you
  take this shortcut, arm scopes must be disjoint by construction (one
  package per arm) and the pre-release review gate is mandatory. Observed
  live: 8 concurrent implement-arms coexisted only because their package
  scopes never overlapped, and the review still caught a duplicate index
  and an unsafe append optimization that a gather stage could have
  rejected before any edit.

## Roster

The recipes assume role-shaped identities exist (a scout, an implementer, a
reviewer). Check `aux` action `list` before writing a program; if a role is
missing, define it first — the `aux-agents` skill carries the doctrine.
