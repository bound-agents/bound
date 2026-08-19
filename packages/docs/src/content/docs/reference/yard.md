---
title: Yard reference
description: Look up Yard invocation fields, effects, results, budgets, failures, and runtime limits.
---

Yard executes a bounded JavaScript generator that coordinates Bound tools, inference, and auxiliary agents. This page defines its invocation and runtime contracts. For workflow patterns, see [Orchestrate work with Yard](/bound/guides/orchestrate-with-yard/).

## Invocation

The `yard` tool accepts one object.

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `program` | string | Yes | — | Complete JavaScript source that defines a top-level `function* main(input) { ... }`. |
| `input` | JSON-compatible value | No | `undefined` | Value passed to `main` and exposed as the deeply frozen `input` global. A string containing a JSON object or array is decoded before execution. Other strings remain strings. |
| `budget` | object | No | See below | Root limits for the complete recursive Yard tree. Nested Yard calls must omit this field. |
| `budget.timeout_seconds` | positive number | With `budget` | `300` when `budget` is omitted | Absolute wall-clock deadline, in seconds, for the complete tree. |
| `budget.concurrency` | integer of at least 1 | With `budget` | `4` when `budget` is omitted | Tree-wide maximum number of concurrent leaf tool, inference, and auxiliary-agent effects. |

`budget` is strict: it accepts only `timeout_seconds` and `concurrency`, and both fields are required when the object is present.

A successful invocation returns this JSON object:

| Field | Type | Description |
| --- | --- | --- |
| `result` | JSON-compatible value | Value returned by `main`. A missing or `undefined` return becomes `null`. |
| `trace_id` | string | Identifier shared by every Yard run in the recursive tree. |
| `usage.tool_calls` | integer | Number of dispatched leaf tool effects, including auxiliary-agent calls. |
| `usage.inference_calls` | integer | Number of dispatched inference effects. |
| `usage.inference_tokens` | integer | Input and output tokens reported by completed inference effects. |
| `usage.elapsed_ms` | integer | Elapsed time for this Yard run. |

An uncaught run failure returns a tool error string prefixed with `Error:` instead of the success object.

## Program contract

`program` must define a top-level generator named `main`. Yard calls it with `input` and drives it until it returns.

Effect constructors describe work but do not start it. Yielding an effect suspends the generator. Yard dispatches the effect and resumes the generator with its result. A dispatch failure is thrown into the generator as an `Error` whose name is `YardEffectError`.

Only branded effects created by `tool()`, `infer()`, `aux()`, `all()`, or `sequence()` can be yielded. Plain objects that resemble effects are rejected.

### JSON boundary

Values crossing between the generator and host must be JSON-compatible:

- `null`
- booleans
- finite numbers
- strings
- arrays of JSON-compatible values
- objects whose enumerable values are JSON-compatible

Functions, `undefined` inside a returned structure, symbols, big integers, and non-finite numbers fail boundary validation. The input is deeply frozen. Each dispatched result is serialized through the same boundary; an `undefined` effect result becomes `null`.

Yard rejects implicit plain-object-to-string coercion that would produce `[object Object]`. Pass structured data through `infer()`'s `input` field or serialize it explicitly with `JSON.stringify()`.

## Effects

### `tool(name, args)`

Creates an effect for one ordinary tool in the current effective toolset.

| Parameter | Type | Required | Default |
| --- | --- | --- | --- |
| `name` | non-empty string | Yes | — |
| `args` | JSON-compatible value | No | `{}` |

The named tool must be available in the current tool registry and retain its normal schema, execution path, and capability restrictions. Yard does not grant tools or permissions. A tool result that contains JSON is returned to the generator as structured data; other output is returned as a string. Deferred or background tool results are rejected because the running generator cannot resolve them.

Nested Yard runs use `tool("yard", { program, input })`. See [Budgets and nesting](#budgets-and-nesting).

### `infer(modelId, request)`

Creates an inference effect with an explicit model ID.

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `modelId` | non-empty string | Yes | — | Model resolved through Bound's model router. |
| `request.prompt` | string | Yes | — | User prompt sent to the model. |
| `request.input` | JSON-compatible value | No | — | Serialized after the prompt under an `Input:` label. |
| `request.schema` | JSON-compatible schema object | No | — | Requests and validates structured JSON output. |
| `request.max_tokens` | number | No | `4096` | Requested maximum output tokens, capped by the resolved model's maximum when one is configured. |

Without `schema`, the result is the model's trimmed text. With `schema`, Yard requests JSON-only output, removes one optional `json` Markdown fence, parses the text as JSON, and validates it. The validator implements these schema keywords:

- `type`, including `integer`
- `enum`
- `properties`
- `required`
- `items`

Unknown schema keywords are ignored. Yard does not automatically repair malformed JSON or schema violations. Either failure rejects the effect.

An inference effect has no tools, filesystem, repository, or conversation context. It receives only the generated user message containing `prompt`, optional `input`, and optional schema instructions.

### `aux(name, instructions, options?)`

Creates a synchronous auxiliary-agent invocation. It is equivalent to:

```js
tool("aux", {
  action: "invoke",
  name,
  instructions,
  ...options,
})
```

`name` and `instructions` must be non-empty strings. `options` is merged into the ordinary `aux` invocation, so accepted options and their validation come from that tool's current schema.

Background invocation is unsupported. A result marked as deferred is rejected because it has no path back into the running generator. Use `all()` for concurrent synchronous auxiliary-agent calls.

A Yard program running inside an auxiliary agent cannot construct or dispatch another auxiliary-agent call. `aux()` fails at construction before any sibling effects dispatch; raw `tool("aux", ...)` is also rejected at dispatch. The auxiliary agent must use its available `tool()` and `infer()` effects directly or return findings to the main agent.

### `all(effects, options?)`

Creates a concurrent compound effect. `effects` must be an array of branded effects.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency` | number of at least 1 | Number of children | Local maximum number of child effects started at once. The root tree-wide concurrency budget also applies. |
| `errors` | `"fail-fast"` or `"settled"` | `"fail-fast"` | Controls child-failure handling. |

Results preserve input order, regardless of completion order.

With `errors: "fail-fast"`, the first observed child failure is thrown into the generator. No new children start after that failure is observed, but already running children are awaited; they are not automatically cancelled by the compound effect.

With `errors: "settled"`, every child is run and each input position contains one of these objects:

```js
{ status: "fulfilled", value }
{ status: "rejected", reason }
```

`reason` is the failure message as a string.

### `sequence(effects)`

Creates an ordered compound effect. `effects` must be an array of branded effects. Yard runs one child at a time, returns an input-ordered array of results, and stops at the first failure. The failure is thrown into the generator.

## Failures and retries

Failures before or outside effect dispatch fail the run. These include invalid JavaScript, a missing or non-generator `main`, invalid constructor arguments, unbranded effects, unsupported JSON values, runtime-limit violations, and an uncaught exception from guest code.

Dispatch failures are thrown at the corresponding `yield` as `YardEffectError`. Examples include unavailable tools or models, tool execution errors, structured-output parse or schema failures, delegation-boundary violations, and deadline expiry. Guest code can catch that error.

Yard performs no general automatic retries. It does not repair and retry structured inference, retry failed tools, or retry failed compound children. A generator can explicitly yield a new effect after catching a failure. Each new dispatch counts in `usage` and remains subject to the original root deadline and concurrency budget.

## Budgets and nesting

The root `budget` creates one absolute deadline and one leaf-work concurrency limit for the entire recursive tree.

- The deadline includes guest execution, tool calls, inference, auxiliary agents, and nested Yard runs.
- Deadline expiry aborts the tree and is propagated to in-flight operations that support cancellation.
- The concurrency limit covers ordinary tools, inference, and auxiliary-agent invocations.
- A nested Yard call does not acquire a leaf permit while it waits for its child run.
- `all()` can impose a lower local concurrency limit but cannot bypass the tree-wide limit.

A nested invocation must omit `budget`; it inherits the root deadline and concurrency unchanged. Each nested invocation uses a fresh isolated JavaScript runtime and returns its own `{ result, trace_id, usage }` object. The tree supports run depths `0` through `3`; attempting a fourth nested child fails with the maximum depth of `4` reached.

Compound-effect payloads support at most eight nested compound levels; a deeper serialized effect payload is rejected.

## Runtime and sandbox limits

Each Yard run uses a fresh restricted QuickJS runtime. Guest code has no ambient access to:

- filesystem or network I/O
- `fetch`, `process`, `require`, `Bun`, or module loading
- clocks or `Date`
- randomness through `Math.random()`
- timers
- promises or `async`/`await`
- dynamic code compilation through `eval` or `Function`

External work is available only through yielded effects. Intrinsic constructors and prototypes are frozen; objects and prototypes created by the program remain writable.

The shipped runtime applies these non-configurable safety ceilings:

| Limit | Value | Scope |
| --- | --- | --- |
| Program source | 512 KiB | UTF-8 source for one run |
| Runtime memory | 128 MiB | One QuickJS runtime |
| Runtime stack | 1 MiB | One QuickJS runtime |
| Uninterrupted guest CPU | 2 seconds | Each entry into guest code; time awaiting host effects does not count |
| Boundary value | 4 MiB | Each serialized value crossing between guest and host |

These ceilings are separate from the root wall-clock budget. They cannot be changed through the `yard` invocation.
