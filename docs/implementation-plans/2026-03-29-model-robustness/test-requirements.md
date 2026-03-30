# Model Robustness — Test Requirements

Maps each acceptance criterion from the [design plan](../../design-plans/2026-03-29-model-robustness.md) to either an automated test or a human-verification step. Every AC appears in exactly one category.

---

## Automated Tests

### model-robustness.AC1: Image and document content blocks

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC1.1 | integration | `packages/platforms/src/__tests__/discord-attachment.test.ts` | A small Discord image attachment (< 1 MB) is downloaded, normalized to an `image` ContentBlock with `base64` source, persisted to `messages.content` as JSON, and round-trips through `JSON.parse` without data loss (base64 data, media_type, and description all preserved). |
| model-robustness.AC1.2 | integration | `packages/platforms/src/__tests__/discord-attachment.test.ts` | A large Discord image attachment (>= 1 MB) is stored as a `file_ref` entry in the `files` table; the `image` ContentBlock in `messages.content` carries `source.type === "file_ref"` with a `file_id` matching the `files` row; `JSON.parse` round-trip preserves the `file_id` reference. |
| model-robustness.AC1.3 | **De-scoped** | N/A | De-scoped: document block ingestion deferred to future plan. The `document` ContentBlock type is defined (Phase 1) and context assembly handles it (Phase 5), but no connector creates document blocks in this plan. Noted in phase_07.md. |
| model-robustness.AC1.4 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | `resolveModel()` called with `requirements: { vision: true }` against a backend whose effective capabilities have `vision: false` (and no alternative vision-capable backend exists) returns `kind: "error"` with `reason: "capability-mismatch"` and `unmetCapabilities` containing `"vision"`. The image block is never silently stripped; the request is rejected before dispatch. |
| model-robustness.AC1.5 | unit | `packages/agent/src/__tests__/context-assembly-substitution.test.ts` | When `assembleContext()` is called with `targetCapabilities.vision === false`, historical messages containing `image` ContentBlocks in the assembled `LLMMessage[]` have their image blocks replaced with `{ type: "text", text: "[Image: ...]" }` annotations. A separate assertion re-queries the `messages` table and confirms the persisted `content` column is unchanged. |

### model-robustness.AC2: Three-phase model resolution

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC2.1 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | `resolveModel()` called with `requirements: { vision: true }` where the primary backend lacks vision but an alternative has `vision: true`: returns `kind: "local"` with the alternative backend's `modelId`. |
| model-robustness.AC2.2 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | When the primary backend lacks a required capability and resolution re-routes to an alternative, the returned `ModelResolution` has `reResolved: true`. |
| model-robustness.AC2.3 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | When no backend in the cluster (local or remote) declares the required capability, `resolveModel()` returns `kind: "error"` with `reason: "capability-mismatch"` and a non-empty `unmetCapabilities` array listing the missing capabilities. |
| model-robustness.AC2.4 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | When capable backends exist but are all rate-limited (via `markRateLimited()`), `resolveModel()` returns `kind: "error"` with `reason: "transient-unavailable"` and an `earliestRecovery` timestamp that is greater than `Date.now()`. |
| model-robustness.AC2.5 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | `resolveModel()` called without a `requirements` argument (text-only request) returns the identified backend unchanged with `reResolved` absent/undefined — backward-compatible behavior. |

### model-robustness.AC3: Per-model capability overrides

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC3.1 | unit | `packages/llm/src/__tests__/model-router.test.ts` | A `createModelRouter()` config with `provider: "ollama"` (baseline `vision: false`) and `capabilities: { vision: true }` override: `router.getEffectiveCapabilities(id)` returns `vision: true`. |
| model-robustness.AC3.2 | unit | `packages/llm/src/__tests__/model-router.test.ts` | Same config as AC3.1 (only `vision` overridden): `getEffectiveCapabilities(id)` returns provider-default values for all non-overridden fields (`streaming`, `tool_use`, `system_prompt`, `max_context`). |
| model-robustness.AC3.3 | unit | `packages/llm/src/__tests__/model-router.test.ts` | A `createModelRouter()` config with `provider: "anthropic"` (baseline `vision: true`) and `capabilities: { vision: false }`: `getEffectiveCapabilities(id)` returns `vision: false`. |
| model-robustness.AC3.4 | unit | `packages/llm/src/__tests__/model-router.test.ts` | A `createModelRouter()` config with no `capabilities` field on the backend entry: `getEffectiveCapabilities(id)` returns the driver's baseline capabilities unchanged (Ollama defaults: `vision: false`, `tool_use: true`, etc.). |

### model-robustness.AC4: Cache-aware token usage

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC4.1 | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | Mock Anthropic SSE stream where `message_start.message.usage` includes `cache_creation_input_tokens: 150` and `cache_read_input_tokens: 200`: the emitted `done` chunk has `usage.cache_write_tokens === 150` and `usage.cache_read_tokens === 200`. |
| model-robustness.AC4.2 | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | Mock Bedrock `ConverseStream` metadata event with `cacheWriteInputTokens: 80` and `cacheReadInputTokens: 120`: the emitted `done` chunk has `usage.cache_write_tokens === 80` and `usage.cache_read_tokens === 120`. |
| model-robustness.AC4.3 | unit | `packages/llm/src/__tests__/openai-driver.test.ts` | Mock OpenAI SSE stream with a final usage chunk containing `prompt_tokens_details.cached_tokens: 50`: the emitted `done` chunk has `usage.cache_read_tokens === 50` and `usage.cache_write_tokens === null` (OpenAI does not report write). |
| model-robustness.AC4.4 | unit | `packages/llm/src/__tests__/ollama-driver.test.ts` | Mock Ollama NDJSON response with `prompt_eval_count: 5, eval_count: 3, done: true`: the emitted `done` chunk has `usage.cache_write_tokens === null` and `usage.cache_read_tokens === null`. |
| model-robustness.AC4.5 | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts`, `packages/llm/src/__tests__/bedrock-driver.test.ts`, `packages/llm/src/__tests__/openai-driver.test.ts`, `packages/llm/src/__tests__/ollama-driver.test.ts` | Each driver is tested with a mock response where token counts are all zero but text output is non-empty: the emitted `done` chunk has `usage.estimated === true` and `usage.input_tokens > 0` and `usage.output_tokens > 0` (char-ratio fallback). |
| model-robustness.AC4.6 | integration | `packages/core/src/__tests__/metrics-schema.test.ts` | After applying the schema (including idempotent `ALTER TABLE`), call `recordTurn()` with `tokens_cache_write: 100, tokens_cache_read: 50`: query the `turns` table and assert the two columns contain the expected values. A second call with `null` values asserts `NULL` is stored in the DB. |

### model-robustness.AC5: Rate-limit handling

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC5.1 | unit | `packages/llm/src/__tests__/model-router.test.ts` | `router.markRateLimited("backend-id", 60_000)` followed by `router.isRateLimited("backend-id")` returns `true`. Also tested end-to-end in the agent-loop: a mock 429 response causes the backend to be marked rate-limited (verified via `isRateLimited()`). |
| model-robustness.AC5.2 | unit | `packages/llm/src/__tests__/model-router.test.ts` | `router.markRateLimited("backend-id", 1)` (1 ms window), then after a `setTimeout(5ms)`, `router.isRateLimited("backend-id")` returns `false` (window expired, backend re-eligible). |
| model-robustness.AC5.3 | unit | `packages/agent/src/__tests__/model-resolution.test.ts` | Primary backend is rate-limited (`markRateLimited`), an alternative backend with matching capabilities exists: `resolveModel()` returns the alternative with `reResolved: true`. |
| model-robustness.AC5.4 | unit | `packages/llm/src/__tests__/model-router.test.ts` and `packages/agent/src/__tests__/model-resolution.test.ts` | Router level: `listEligible()` excludes all rate-limited backends, returning an empty list. Resolution level: `resolveModel()` returns `kind: "error"` with `reason: "transient-unavailable"` and a numeric `earliestRecovery` timestamp. |

### model-robustness.AC6: Tool call identity

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC6.1 | unit | `packages/llm/src/__tests__/ollama-driver.test.ts` | Mock Ollama response with two tool calls to the same function (`search`): the two emitted `tool_use_start` chunks have distinct `id` values matching the pattern `ollama-{ts}-0` and `ollama-{ts}-1`. |
| model-robustness.AC6.2 | unit | `packages/llm/src/__tests__/openai-driver.test.ts` | Two test cases: (a) Mock OpenAI stream with two tool calls that carry distinct provider-supplied IDs: both IDs pass through unchanged. (b) Mock OpenAI stream with two tool calls whose deltas have empty `id` fields: the driver synthesizes distinct IDs matching `openai-{ts}-{index}`. |
| model-robustness.AC6.3 | unit | `packages/agent/src/__tests__/agent-loop.test.ts` | Mock LLM backend yields `tool_use_start` chunks with Anthropic/Bedrock-style native IDs (`"toolu_01"`, `"toolu_02"`): collision detection pre-pass in `parseResponseChunks()` does not reassign them; the `ParsedToolCall` results carry the original IDs unchanged. |
| model-robustness.AC6.4 | unit | `packages/agent/src/__tests__/agent-loop.test.ts` | Mock LLM backend yields three sequential tool calls all with the same `id` (`"search"`): collision detection pre-pass reassigns the 2nd and 3rd to unique deduped IDs (with `-dedup-` infix); `logger.warn` is called twice (once per duplicate); all three `ParsedToolCall` items have distinct IDs. |

### model-robustness.AC7: Remote capability metadata

| AC ID | Test Type | Test File | Description |
|---|---|---|---|
| model-robustness.AC7.1 | unit | `packages/agent/src/__tests__/relay-router.test.ts` | A host row with `models: JSON.stringify([{ id: "claude-3", tier: 1, capabilities: { vision: true, tool_use: true } }])`: `findEligibleHostsByModel()` returns `EligibleHost` with `capabilities.vision === true`, `tier === 1`, and `unverified === false`. |
| model-robustness.AC7.2 | unit | `packages/agent/src/__tests__/relay-router.test.ts` | Two remote hosts advertising `claude-3` — one with `vision: true`, one with `vision: false`: `findEligibleHostsByModel("claude-3", ..., { vision: true })` returns only the host with `vision: true`. Also tested end-to-end: `resolveModel("vision-model", ..., { vision: true })` excludes the remote host advertising `vision: false`. |
| model-robustness.AC7.3 | unit | `packages/agent/src/__tests__/relay-router.test.ts` | One verified host with `vision: false` and one legacy string-format host for the same model: `findEligibleHostsByModel(..., { vision: true })` falls back to the unverified (legacy) host. Without requirements, both are returned (verified first). |
| model-robustness.AC7.4 | unit | `packages/agent/src/__tests__/relay-router.test.ts` | A host row with `models: JSON.stringify(["old-model", { id: "new-model", tier: 1, capabilities: { vision: true } }])` (mixed format): both entries parse without error; `findEligibleHostsByModel("old-model")` returns `unverified: true`, `findEligibleHostsByModel("new-model")` returns `unverified: false` with capabilities. |
| model-robustness.AC7.5 | integration | `packages/platforms/src/__tests__/discord-attachment.test.ts` | Discord connector receives a mock message with an image attachment: the attachment is downloaded, normalized to an `image` ContentBlock, and persisted to `messages.content`. Inline (< 1 MB) and file_ref (>= 1 MB) thresholds are both tested. A text-only message (no attachments) stores plain text content (backward-compatible). |

---

## Human Verification

No acceptance criteria in this plan require human verification. All ACs are covered by automated tests (unit or integration) as specified above, with the exception of model-robustness.AC1.3 which is de-scoped.

---

## Summary

| Category | Count |
|---|---|
| Automated (unit) | 24 |
| Automated (integration) | 5 |
| De-scoped | 1 (model-robustness.AC1.3) |
| Human verification | 0 |
| **Total ACs** | **30** |
