---
title: Orchestrate work with Yard
description: Use Yard to coordinate bounded tool calls, inference, and auxiliary agents in one JavaScript generator.
---

Use Yard when one agent turn needs to coordinate several bounded operations while keeping their intermediate data out of the conversation. Yard is useful for a staged investigation, a concurrent review, or a large change that needs survey, implementation, and review steps.

Yard is not a replacement for ordinary tool calls. Use a normal tool call for one direct operation. Use an auxiliary agent for a substantial errand that needs tools and judgment. Use Yard when you need to coordinate those operations, preserve their results between stages, and return one concise result.

## Before you begin

- Use a model ID that is available to Bound.
- Define any auxiliary-agent identities that the program will invoke. See [Auxiliary agents](/bound/concepts/auxiliary-agents/).
- For multi-step repository work, activate the `yard-recipes` skill before writing the program. It provides patterns for partitioning, review, repair, and release.

## Build a concurrent review

This example asks two existing auxiliary identities to review different questions, then uses structured inference to turn their reports into a decision. It returns only the reports and decision, rather than every intermediate tool result from the child threads.

```js
function* main(input) {
  const reviews = yield all([
    aux("security-reviewer", input.securityQuestion, { model: input.model }),
    aux("architecture-reviewer", input.designQuestion, { model: input.model }),
  ], { concurrency: 2, errors: "settled" });

  const decision = yield infer(input.model, {
    prompt: "Summarize the reviews. Preserve disagreements and name the next action.",
    input: reviews,
    schema: {
      type: "object",
      properties: {
        conclusion: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
        next_action: { type: "string" },
      },
      required: ["conclusion", "risks", "next_action"],
    },
  });

  return { reviews, decision };
}
```

Invoke it through the `yard` tool with JSON-compatible input:

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

The program yields an effect, pauses, and receives the effect's result when it resumes. `all()` preserves the input order of its results, including when its children finish in a different order. With `errors: "settled"`, each result is either `{ status: "fulfilled", value }` or `{ status: "rejected", reason }`; inspect those results before treating the review as complete.

## Coordinate a repository-wide change

For work that spans independent areas, keep the stages inside one Yard program:

1. Enumerate independent partitions with a small `tool()` call.
2. Use `all()` and one read-only `aux()` errand per partition to survey them.
3. Pass the reports as `input` to `infer()` to create structured work orders.
4. Run implementation errands for the selected work orders.
5. Send the uncommitted result to a reviewer errand.
6. Route concrete review objections to an implementer. Only a final, separate release errand should commit or push.

Keep concurrent write errands file-disjoint. If several changes converge on one registry, manifest, or source file, assign that work to one implementer instead of running competing writers. Return per-partition outcomes, including skipped partitions and why, so a successful summary does not conceal missing coverage.

## Handle failures deliberately

A failed effect is thrown back into the generator as an `Error`, so you can handle a known failure locally:

```js
function* main(input) {
  try {
    return yield tool("query", { sql: input.sql });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
```

Do not use a blanket catch to hide failures in a large workflow. For concurrent work, prefer `all(..., { errors: "settled" })`, examine every result, and re-dispatch work whose report shows that coverage is incomplete. An inference response that fails its requested schema also throws; Yard does not repair malformed structured output automatically.

## Work within the boundaries

Yard programs run in a restricted JavaScript environment. They cannot use the filesystem, network, process APIs, modules, timers, clocks, randomness, promises, or `async`/`await`. Yield an effect to request work instead.

The input and returned result must be JSON-compatible. Input is read-only. Pass structured values to `infer()` through its `input` field; do not interpolate an object into a prompt or an auxiliary instruction. Use `JSON.stringify()` when text is required.

The root invocation can set a deadline and a tree-wide concurrency limit. Those limits include nested Yard calls and their leaf tool, inference, and auxiliary-agent work. A nested `tool("yard", ...)` call must omit `budget`; it inherits the root limits. Nested Yard calls are capped, and Yard inside an auxiliary agent cannot use `aux()` to create another delegation layer. Return findings to the main agent for any further fan-out.

See [Yard reference](/bound/reference/yard/) for the invocation schema, effect contracts, defaults, and error behavior.
