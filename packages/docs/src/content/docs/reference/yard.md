---
title: Yard reference
description: Reference for the Yard orchestration tool, its generator program, effects, budgets, and failure behavior.
---

Yard runs a bounded JavaScript generator that coordinates Bound tools, inference, and auxiliary agents. Use [Orchestrate work with Yard](/bound/guides/orchestrate-with-yard/) for a guided workflow and [Agent tools](/bound/reference/agent-tools/) for the native-tools index.

## Invocation

Call `yard` with the following object:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `program` | string | Yes | A complete program defining `function* main(input) { ... }`. |
| `input` | JSON-compatible value | No | Read-only value exposed as `input` and passed to `main`. A JSON string containing an object or array is decoded before the program starts; scalar strings remain strings. |
| `budget` | object | No | Root limits for the complete Yard tree. Omit it to use the defaults. |
| `budget.timeout_seconds` | positive number | Yes, with `budget` | Absolute deadline for the full tree. Default: `300`. |
| `budget.concurrency` | integer, at least 1 | Yes, with `budget` | Tree-wide cap on concurrently running leaf tools, inferences, and auxiliary agents. Default: `4`. |

The tool returns a JSON object with:

| Field | Description |
| --- | --- |
| `result` | The JSON-compatible value returned by `main`. |
| `trace_id` | Identifier for the Yard execution tree. |
| `usage` | Counts for tool calls and inference calls, inference tokens, and elapsed time. |

## Program model

A Yard program must define a top-level generator named `main`:

```js
function* main(input) {
  const result = yield tool("query", { sql: "SELECT 1" });
  return { result };
}
```

Effect constructors create descriptions of work; they do not start it. `yield` suspends the generator, Yard performs the effect, and the generator resumes with the result. A failed effect is thrown into the generator as an `Error`, so a program can catch a failure and choose how to proceed.

Programs and values crossing the Yard boundary must be JSON-compatible: `null`, booleans, finite numbers, strings, arrays, and plain objects containing those values. The input is deeply frozen. Returning a function, `undefined`, a non-finite number, or another non-JSON value fails the run.

## Effects

### `tool(name, args)`

Creates one call to an ordinary Bound tool in the current effective toolset.

```js
const matches = yield tool("boundless_search", {
  pattern: "TODO",
  path: "packages/agent",
});
```

Use the target tool's normal argument schema. Tool availability and the usual tool permissions still apply. Use `tool()` for small coordination operations such as enumeration or a final validation. For a substantial errand requiring multiple tools and judgment, use `aux()` instead.

### `infer(modelId, request)`

Creates a text-to-text inference request. `modelId` is required and must name a model available to Bound.

```js
const plan = yield infer(input.model, {
  prompt: "Turn these survey reports into work orders.",
  input: reports,
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
  max_tokens: 1200,
});
```

Without `schema`, the result is a string. With `schema`, Yard parses the response as JSON and returns the parsed value only when it satisfies the supported schema fields:

- `type`
- `properties`
- `required`
- `items`
- `enum`

A malformed response or schema violation fails the effect. Yard does not make a repair request automatically; catch the error and retry explicitly when that is appropriate.

`infer()` has no tools, filesystem, or access to the repository. It receives only `prompt` and optional structured `input`. Use it to classify, plan, extract, or synthesize information collected by other effects. Do not ask it to inspect files or apply changes.

### `aux(name, instructions, options?)`

Creates a synchronous auxiliary-agent invocation. It is shorthand for an `aux` tool invocation with `action: "invoke"`.

```js
const report = yield aux(
  "scout",
  "Survey packages/agent for error paths. Do not edit files. Report paths and findings.",
  { model: input.model },
);
```

Use `all()` to run several auxiliary errands concurrently. `background: true` is not supported inside Yard because a background result has no resolution path back into the running generator.

An auxiliary agent cannot use `aux()` from its own Yard program. That boundary prevents nested delegation; use direct `tool()` and `infer()` effects in the auxiliary errand, or return findings to the main agent for further fan-out.

### `all(effects, options?)`

Runs child effects concurrently and returns results in the same order as the input effects.

| Option | Default | Behavior |
| --- | --- | --- |
| `concurrency` | Number of children | Maximum number of this `all()` effect's children started at once. The root tree-wide budget still applies. |
| `errors` | `"fail-fast"` | Use `"settled"` to receive one status object per child instead of throwing at the first observed failure. |

With `errors: "settled"`, each entry is either `{ status: "fulfilled", value }` or `{ status: "rejected", reason }`.

```js
const reports = yield all(
  scopes.map((scope) => aux("scout", `Survey ${scope}; make no edits.`, { model: input.model })),
  { concurrency: 4, errors: "settled" },
);
```

A fulfilled auxiliary result is not proof that the requested coverage happened. Inspect every report and treat incomplete status narration as missing coverage.

### `sequence(effects)`

Runs child effects in order and returns an array of their results. It stops and throws on the first failure.

```js
const [listed, checked] = yield sequence([
  tool("boundless_bash", { command: "git status --short" }),
  tool("boundless_bash", { command: "bun run check" }),
]);
```

## Errors and retries

Effect failures are thrown into the generator as `YardEffectError` instances. Handle only failures for which the program has a concrete recovery path:

```js
function* main(input) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return yield infer(input.model, {
        prompt: "Return a JSON decision.",
        schema: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"] },
      });
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}
```

Invalid JavaScript, a missing generator `main`, invalid effect construction, unsupported non-JSON values, unknown tools, unavailable models, denied tool calls, and expired deadlines fail the invocation. Plain objects that merely resemble effects are rejected; construct effects only with `tool()`, `infer()`, `aux()`, `all()`, or `sequence()`.

Do not interpolate a plain object into an instruction or prompt string. Yard rejects the common accidental conversion to `[object Object]`, because it loses the data. Pass data through `infer(..., { input })`, or use `JSON.stringify(value)` when an instruction must contain serialized data.

## Limits and nesting

The root `budget` applies to the entire recursive execution tree. A nested Yard program may be invoked through `tool("yard", { program, input })`, but it must not specify `budget`; it inherits the root deadline and concurrency limit. Yard limits nesting depth.

`all()` can request a local concurrency cap, but cannot exceed the tree-wide budget. A waiting nested Yard call does not consume a leaf-work slot; ordinary tools, inferences, and auxiliary invocations do.

## Security boundaries

Yard runs JavaScript in a restricted environment. It has no ambient network, filesystem, process, module loader, clock, random source, timer, promise, or `async`/`await` support. It can request external work only by yielding a branded effect.

The JavaScript runtime also enforces limits on program source size, memory, stack use, uninterrupted CPU time, and the size of values crossing the Yard boundary. These are implementation safety limits, not configurable `yard` parameters.

A `tool()` effect is subject to the same schema validation, tool availability, and side-effect policy as a direct invocation. Yard does not grant additional permissions. Auxiliary agents retain their own capability boundaries, including the one-level delegation rule.
