# Agent-Loop Diagnostic Harness

A hermetic, in-process driver for the bound `AgentLoop` against live LLM inference. Iterate placement decisions, context-assembly behavior, inflation EMA, and other agent-loop invariants with a fixture-driven scenario, capture per-turn data through pluggable diagnostics, and converge on correct code without restarting the daemon every cycle.

The harness is **general-purpose** — cache iteration is its first user, but the same scaffold serves any future diagnostic that wants to observe agent-loop behavior across N turns with deterministic inputs and live inference outputs.

## Quick start

```bash
bun run packages/agent/scripts/agent-harness/run.ts \
  --config-dir ~/bound/config \
  --backend sonnet \
  --fixture autonomous-task \
  --diagnostic cache \
  --turns 5 \
  --budget 1.00
```

`--budget` is required and has no default. The harness aborts at three checkpoints (pre-flight estimate, per-turn projection, post-turn hard stop with 5% slack) against this value. There is no environment-variable foot-gun guard — every invocation explicitly states its dollar ceiling.

Credentials come from whatever `model_backends.json` already configures for the chosen `--backend` (e.g., the `profile` field for Bedrock). If the daemon can use the backend, the harness can use the backend — the harness adds no parallel auth surface.

## CLI flags

| flag | required | default | meaning |
| --- | --- | --- | --- |
| `--budget <usd>` | YES | — | Hard ceiling in USD. Bare invocation without this fails. |
| `--config-dir <path>` | no | `./config` | Where `model_backends.json` lives. |
| `--backend <id>` | no | router default | Backend ID from `model_backends.json` to drive. |
| `--fixture <name>` | YES | — | Fixture from `fixtures/` to run. |
| `--diagnostic <name[,...]>` | no | `cache` | Diagnostic plugin(s) to run; comma-separated for multiple. |
| `--turns <n>` | no | `5` | Number of turns to drive. |
| `--log-level <level>` | no | `silent` | `silent\|trace\|debug\|info\|warn\|error\|fatal`. `debug` surfaces AI SDK request bodies. |
| `--dump-wire <path>` | no | unset | Write each turn's wire bodies to `<path>/turn-N.json` for offline inspection. |

## Output

The cache diagnostic emits a per-turn table plus a cumulative footer:

```
  n  path  sys  msg  cr        cw        cost_usd  wire_diff_vs_prev
  -- ----  ---  ---  --------  --------  --------  -----------------
  1  cold  1    1    2,208     471       0.0171    n/a
  2  warm  1    1    2,679     150       0.0011    stable
  3  warm  1    1    2,829     200       0.0012    stable
  ...

  cumulative:
    total_cr:           21,540
    total_cw:           1,250
    cache_hit_rate:     94.51%
    total_cost_usd:     0.0853
    longest_stable_run: 8 turns
```

Columns:

- `path` — `cold` / `warm` / `unknown` from `context_debug.cachePath`.
- `sys` — number of cache markers attached to the system block on the wire.
- `msg` — number of cache markers attached to messages on the wire.
- `cr` / `cw` — cache_read / cache_write tokens reported by the provider, normalized across providers by `ai-sdk-bridge.mapChunks`.
- `cost_usd` — turn cost via `calculateTurnCost` against the same backend pricing the daemon uses.
- `wire_diff_vs_prev` — first byte index where this turn's wire body diverges from the previous turn's. `stable` = byte-equal. `n/a` = no prior turn. `@N of M` = diverged at byte N out of M total. The killer field for tracking down which content shifted at a cache-thrash boundary.

## Adding a fixture

Copy `fixtures/autonomous-task.ts`, edit the prompt + tools + summary to match the scenario you want to reproduce, register in `fixtures/index.ts`'s `registerBuiltinFixtures()`. Fixtures are provider-agnostic by construction.

## Adding a diagnostic

Implement the `Diagnostic` interface in `diagnostics/types.ts` (a `collect(turnData)` extractor + a `render(records)` formatter), drop the file into `diagnostics/`, register in `diagnostics/index.ts`'s `registerBuiltinDiagnostics()`. Multiple diagnostics can run in one invocation via `--diagnostic cache,inflation-ema`.

The `DiagnosticTurnData` argument carries everything observable about a turn: cachePath, raw wire bodies, normalized usage, the full `context_debug` record, and the turn's cost.

## Adding a provider

The harness has zero provider-specific code. Provider differences live in two existing seams:

1. **Driver constructors** (`packages/llm/src/bedrock-driver.ts`, `packages/llm/src/openai-compatible-driver.ts`) — each accepts an optional `fetch?: typeof fetch` field. New drivers need the same field for the harness's capturing fetch to attach.
2. **`createBackendFromConfig`** (`packages/llm/src/model-router.ts`) — dispatches on `BackendConfig.provider`. New providers slot into the existing `switch`.

If a provider uses a wire-body cache marker key name not in `KNOWN_CACHE_MARKER_KEYS` (currently `cachePoint` for Bedrock and `cache_control` for Anthropic-direct), add it to the set in `capture.ts`. One line, no per-provider dispatch.

## Why not a test?

Live-inference cost and fixture variants make this operator-driven, not pre-PR CI. Per-PR coverage of the same invariants lives in property tests under `packages/agent/src/__tests__/cache-marker-*.test.ts`, which exercise the placer + bridge with no inference at all.

## Design

See `docs/design/agent-system.md` for the agent-loop architecture this harness drives, and the plan file at `~/.claude/plans/lazy-zooming-pebble.md` (`Plan — Agent-Loop Diagnostic Harness`) for the design rationale.
