---
title: Orchestrate work with Yard
description: Coordinate bounded tools, inference, and auxiliary-agent workflows with Yard.
---

Use Yard when one agent turn must coordinate bounded work across several tools, models, or auxiliary agents. This guide builds a concurrent review and shows how to extend the same pattern into a survey, implementation, and review workflow.

Use an ordinary tool call for one direct operation. Use one auxiliary agent for a substantial errand that needs tools and judgment. Choose Yard when later work depends on several earlier results, when independent errands should run concurrently, or when large intermediate results should stay inside one workflow.

## Before you begin

- Select a model ID that is available to Bound.
- Define the auxiliary-agent identities that the workflow will invoke. See [Auxiliary agents](/bound/concepts/auxiliary-agents/).
- Activate the `yard-recipes` skill before writing a nontrivial program. It contains current partitioning, review, repair, and release patterns.
- Identify the smallest independent scopes that each auxiliary agent can cover completely. Concurrent write scopes must not edit the same files.

## Build a concurrent review

1. Define a generator named `main`.

   Yard runs `function* main(input)`. An effect constructor such as `aux()` describes work but does not start it. `yield` pauses the generator, Yard performs the effect, and the generator resumes with its result.

2. Run independent reviews with `all()`.

   The following program sends two questions to existing auxiliary-agent identities. It requests settled results so one failed review does not discard the other review.

   ```js
   function* main(input) {
     const reviews = yield all([
       aux("security-reviewer", input.securityQuestion, { model: input.model }),
       aux("architecture-reviewer", input.designQuestion, { model: input.model }),
     ], { concurrency: 2, errors: "settled" });

     const decision = yield infer(input.model, {
       prompt:
         "Summarize the completed reviews. Preserve disagreements and name the next action. Treat rejected or incomplete reviews as missing evidence.",
       input: reviews,
       schema: {
         type: "object",
         properties: {
           conclusion: { type: "string" },
           risks: { type: "array", items: { type: "string" } },
           missing_evidence: { type: "array", items: { type: "string" } },
           next_action: { type: "string" },
         },
         required: ["conclusion", "risks", "missing_evidence", "next_action"],
       },
     });

     return { reviews, decision };
   }
   ```

   `all()` returns results in input order even when work finishes in another order. With `errors: "settled"`, each entry is either `{ status: "fulfilled", value }` or `{ status: "rejected", reason }`. Without that option, the first observed failure is thrown into the generator and no further queued children start; children already in flight may still complete.

3. Pass collected data to structured inference.

   `infer()` has no tools, filesystem access, or repository context. It sees only its prompt and optional `input`. Use it to classify or synthesize results already collected by tools or auxiliary agents. A `schema` asks Yard to parse and validate JSON; malformed output or a schema violation fails the effect instead of triggering a hidden repair request.

4. Invoke `yard` with JSON-compatible input and a budget.

   ```json
   {
     "program": "function* main(input) { /* program above */ }",
     "input": {
       "model": "gpt-5.6-terra",
       "securityQuestion": "Review the proposed permission boundary.",
       "designQuestion": "Review the proposed data model."
     },
     "budget": {
       "timeout_seconds": 300,
       "concurrency": 2
     }
   }
   ```

   The timeout is an absolute deadline for the complete Yard tree. The concurrency value caps all simultaneously running tool, inference, and auxiliary-agent work in that tree. An `all()` call can set a lower local cap, but cannot exceed the tree-wide budget.

5. Inspect both `reviews` and `decision` in the returned `result`.

   A fulfilled auxiliary-agent call is not proof that it completed its assignment. Treat a progress note, an empty report, or a report without the requested evidence as missing coverage and re-dispatch a smaller scope.

## Expand the workflow from survey to review

Keep dependent stages in the same generator so survey reports become actual plan inputs rather than summaries copied through the conversation.

1. Enumerate the work with a small `tool()` effect.
2. Survey every independent partition with one read-only `aux()` errand per partition.
3. Use schema-constrained `infer()` to turn the reports into work orders.
4. Dispatch implementers only for accepted work orders.
5. Dispatch reviewers against the uncommitted changes and the original acceptance criteria.
6. Route specific objections back to an implementer, then review again.
7. If release is part of the goal, give commit and push ownership to one separate final errand after review passes.

A compact survey and planning stage looks like this:

```js
function* main(input) {
  const scopes = input.scopes;
  if (scopes.length === 0) throw new Error("no scopes supplied");

  const surveys = yield all(
    scopes.map((scope) =>
      aux(
        "scout",
        `Survey ${scope} for: ${input.goal}. Make no edits. Report candidate files and evidence.`,
        { model: input.model },
      )
    ),
    { concurrency: 4, errors: "settled" },
  );

  const orders = yield infer(input.model, {
    prompt:
      "Create one work order per supplied scope. Mark rejected, empty, or incomplete surveys as missing coverage rather than inventing work.",
    input: scopes.map((scope, index) => ({ scope, survey: surveys[index] })),
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          scope: { type: "string" },
          skip: { type: "boolean" },
          order: { type: "string" },
        },
        required: ["scope", "skip", "order"],
      },
    },
  });

  return {
    orders,
    skipped: orders.filter((order) => order.skip).map((order) => order.scope),
  };
}
```

Continue from `orders` inside the same generator: use `all()` for file-disjoint implementation errands, then another `all()` for reviewer errands. Give each reviewer the work order and tell it to inspect the actual diff. Bound retry loops—for example, allow one repair round—and return per-scope outcomes so skipped or failed coverage remains visible.

Use `sequence()` when effects must run in order regardless of their values. It returns an array of results and stops on the first failure. Prefer normal generator statements when the next effect depends on an earlier result.

## Handle expected failures

Catch a failed effect only when the program has a specific recovery path:

```js
function* main(input) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return yield infer(input.model, {
        prompt: "Return a decision from the supplied evidence.",
        input: input.evidence,
        schema: {
          type: "object",
          properties: { decision: { type: "string" } },
          required: ["decision"],
        },
      });
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}
```

Do not use a blanket catch to turn an incomplete workflow into success. For concurrent work, use `errors: "settled"`, inspect every status entry, and re-dispatch only the failed or incomplete scopes. A retry should be bounded and should change something useful, such as narrowing the scope or carrying a reviewer's concrete objections.

## Keep values at the boundary

Yard input, effect arguments and results, and the final return value must be JSON-compatible: `null`, booleans, finite numbers, strings, arrays, and objects containing those values. The input is read-only.

Pass structured data to `infer()` through its `input` field. Do not interpolate an object into a prompt or auxiliary-agent instruction; Yard rejects the common conversion to `[object Object]` because it loses the value. Extract the required fields or use `JSON.stringify()` when an instruction must contain serialized data.

Keep large intermediate reports in generator variables during the run; return only the compact artifact you need after the workflow completes.

## Stay within Yard's boundaries

Yard programs run without ambient filesystem, network, process, module, clock, random, timer, promise, or `async`/`await` access. Request external work by yielding `tool()`, `infer()`, or `aux()` effects. A `tool()` call uses the current effective toolset and remains subject to the same schema checks, sandbox, permissions, and side-effect policy as a direct call; Yard does not grant additional access.

Auxiliary-agent calls inside Yard are synchronous. Do not set `background: true`; use `all()` for concurrency. An auxiliary agent cannot call `aux()` from its own Yard program. It must complete the errand with its tools and `infer()`, or return findings so the main agent can coordinate another fan-out.

A Yard program can invoke another Yard program with `tool("yard", ...)`. Omit `budget` from the nested call: it inherits the root deadline and concurrency cap. Nesting is bounded, so prefer one generator that carries dependent values through the workflow instead of creating deep Yard trees.

See [Yard reference](/bound/reference/yard/) for the complete invocation and effect contracts, defaults, and runtime limits.
