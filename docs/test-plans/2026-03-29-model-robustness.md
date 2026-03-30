# Human Test Plan: Model Robustness

**Implementation plan:** `docs/implementation-plans/2026-03-29-model-robustness/`
**Date:** 2026-03-29

## Prerequisites

- Working development environment with Bun runtime
- All automated tests passing:
  ```bash
  bun test packages/agent/src/__tests__/model-resolution.test.ts
  bun test packages/agent/src/__tests__/context-assembly-substitution.test.ts
  bun test packages/llm/src/__tests__/model-router.test.ts
  bun test packages/llm/src/__tests__/anthropic-driver.test.ts
  bun test packages/llm/src/__tests__/bedrock-driver.test.ts
  bun test packages/llm/src/__tests__/openai-driver.test.ts
  bun test packages/llm/src/__tests__/ollama-driver.test.ts
  bun test packages/core/src/__tests__/metrics-schema.test.ts
  bun test packages/agent/src/__tests__/agent-loop.test.ts
  bun test packages/agent/src/__tests__/relay-router.test.ts
  bun test packages/platforms/src/__tests__/discord-attachment.test.ts
  ```
- A running instance with at least one configured backend (`model_backends.json`)
- Optionally: a Discord bot token configured in `platforms.json` for Discord attachment testing

---

## Phase 1: Image Ingestion End-to-End

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Send a DM to the configured Discord bot with a small (< 1 MB) image attachment and the text "Describe this image" | The bot accepts the message without error. In the database, `messages` table has a row where `content` is a JSON array containing both a `text` block and an `image` block with `source.type === "base64"`. |
| 1.2 | Send a DM with a large (>= 1 MB) image attachment | The bot accepts the message. The `files` table has a new row with base64-encoded content. The `messages.content` JSON has an `image` block with `source.type === "file_ref"` and a `file_id` matching the `files` row. |
| 1.3 | Send a DM with only text (no attachment) | The `messages.content` column stores the raw text string, not a JSON array. Backward-compatible behavior preserved. |
| 1.4 | Send a DM with a PDF attachment | The PDF is skipped (not ingested as an image). The message content is plain text only. No error logged. |

---

## Phase 2: Model Resolution with Capability Requirements

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Configure `model_backends.json` with two backends: one with `capabilities: { vision: false }` and one with `capabilities: { vision: true }`. Start the service and send a message with an image attachment. | The agent resolves to the vision-capable backend. Check the `turns` table: `model_id` should be the vision-capable backend's ID. |
| 2.2 | Configure `model_backends.json` with a single backend that has `vision: false`. Send a message with an image attachment. | The agent returns a capability-mismatch error. An alert message is persisted to the thread explaining that no vision-capable backend is available. |
| 2.3 | Send a text-only message (no images) with the same single non-vision backend configuration. | The agent processes normally using the default backend. No re-resolution occurs. The `turns.model_id` matches the configured backend. |

---

## Phase 3: Capability Override Verification

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | In `model_backends.json`, configure an Ollama backend with `capabilities: { vision: true }`. Start the service. Query `GET /api/status/models`. | The response includes the Ollama backend with `vision: true` in its capabilities, overriding the Ollama driver's default `vision: false`. |
| 3.2 | Configure an Anthropic backend with `capabilities: { vision: false }`. Query `GET /api/status/models`. | The response shows `vision: false` for the Anthropic backend, overriding the driver's default `vision: true`. |

---

## Phase 4: Cache Token Observation

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Configure an Anthropic backend with prompt caching enabled. Send several messages in the same thread (to trigger cache hits). Query the `turns` table. | The `tokens_cache_write` and `tokens_cache_read` columns contain non-null integer values for at least some turns. Early turns should show `tokens_cache_write > 0`, later turns should show `tokens_cache_read > 0`. |
| 4.2 | Configure an Ollama backend. Send a message. Query the `turns` table. | The `tokens_cache_write` and `tokens_cache_read` columns are both `NULL` (Ollama does not support prompt caching). `tokens_in` and `tokens_out` should be non-zero. |

---

## Phase 5: Rate Limiting Recovery

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | Configure two backends, both capable. Trigger a 429 response from the primary (e.g., by sending many requests rapidly to a real API, or by temporarily pointing the primary at a mock that returns 429). | The agent marks the primary as rate-limited, falls back to the alternative backend. The `turns.model_id` for subsequent requests should show the alternative backend's ID. After the rate-limit window expires, the primary becomes eligible again. |

---

## Phase 6: Tool Call Identity in Multi-Tool Responses

| Step | Action | Expected |
|------|--------|----------|
| 6.1 | Configure an Ollama backend. Prompt the agent with a request that triggers multiple tool calls to the same tool (e.g., "Search for 'foo' and then search for 'bar'"). | Both tool calls execute successfully. In the `messages` table, the `tool_call` row's `content` JSON has two `tool_use` entries with distinct IDs (pattern `ollama-{ts}-0` and `ollama-{ts}-1`). Both corresponding `tool_result` rows have matching `tool_use_id` values. |

---

## End-to-End: Vision-Aware Cross-Host Relay

**Purpose**: Validates that model resolution, capability filtering, and context assembly substitution work together across the full stack when a vision-capable model is only available on a remote host.

1. Configure a two-node cluster (hub + spoke). Hub has `model_backends.json` with only a text-only model. Spoke has a vision-capable model and advertises it in `hosts.models` with `capabilities: { vision: true }`.
2. Send a message with an image attachment to the hub node.
3. Verify that `resolveModel` identifies the remote spoke as the only eligible host for the vision requirement.
4. Verify the relay request is created in `relay_outbox` with `kind: "inference"`.
5. On the spoke, verify the inference request is processed and the image content block is included in the LLM call (not stripped).
6. Verify the response relays back to the hub and is persisted to the thread.
7. Send the same thread to a second, non-vision text-only backend for a follow-up (no image). Verify the historical image blocks are substituted with `[Image: ...]` text annotations in the assembled context, but the original `messages` rows are unchanged.

---

## End-to-End: Graceful Degradation with Mixed-Format Hosts

**Purpose**: Validates that clusters with a mix of legacy (string-format) and new (object-format with capabilities) host entries continue to function without errors.

1. Configure a cluster where one host has legacy `models: ["claude-3"]` format and another has new `models: [{ id: "claude-3", tier: 1, capabilities: { vision: true } }]` format.
2. Send a text-only request for `claude-3`. Verify both hosts are eligible (verified host sorted before unverified).
3. Send a request with vision requirement for `claude-3`. Verify only the new-format host (or unverified legacy fallback, if no verified match) is selected.
4. No errors should be logged for parsing the mixed-format host entries.

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | `discord-attachment.test.ts` "small image attachment stored as inline base64" | Phase 1 Step 1.1 |
| AC1.2 | `discord-attachment.test.ts` "large image attachment stored as file_ref" | Phase 1 Step 1.2 |
| AC1.3 | De-scoped (document ingestion deferred) | N/A |
| AC1.4 | `model-resolution.test.ts` "returns capability-mismatch when no backend supports required capability" | Phase 2 Step 2.2 |
| AC1.5 | `context-assembly-substitution.test.ts` "replaces image blocks" + "does not modify database row" | E2E Vision-Aware Cross-Host Relay Step 7 |
| AC2.1 | `model-resolution.test.ts` "routes to vision-capable backend" | Phase 2 Step 2.1 |
| AC2.2 | `model-resolution.test.ts` "sets reResolved: true" | Phase 2 Step 2.1 |
| AC2.3 | `model-resolution.test.ts` "returns capability-mismatch" | Phase 2 Step 2.2 |
| AC2.4 | `model-resolution.test.ts` "returns transient-unavailable with earliestRecovery" | Phase 5 Step 5.1 |
| AC2.5 | `model-resolution.test.ts` "text-only request passes qualification unchanged" | Phase 2 Step 2.3 |
| AC3.1 | `model-router.test.ts` "merges capabilities override" | Phase 3 Step 3.1 |
| AC3.2 | `model-router.test.ts` "unspecified override fields retain provider defaults" | Phase 3 Step 3.1 |
| AC3.3 | `model-router.test.ts` "can suppress vision on a vision-capable provider" | Phase 3 Step 3.2 |
| AC3.4 | `model-router.test.ts` "uses driver baseline when no capabilities override" | Phase 3 Step 3.1 |
| AC4.1 | `anthropic-driver.test.ts` "AC4.1" | Phase 4 Step 4.1 |
| AC4.2 | `bedrock-driver.test.ts` "AC4.2" | Phase 4 Step 4.1 |
| AC4.3 | `openai-driver.test.ts` "AC4.3" | Phase 4 Step 4.1 |
| AC4.4 | `ollama-driver.test.ts` "AC4.4" | Phase 4 Step 4.2 |
| AC4.5 | All four driver tests "AC4.5" | Phase 4 Steps 4.1–4.2 |
| AC4.6 | `metrics-schema.test.ts` "should persist cache token values" | Phase 4 Steps 4.1–4.2 |
| AC5.1 | `model-router.test.ts` "markRateLimited + isRateLimited round-trip" | Phase 5 Step 5.1 |
| AC5.2 | `model-router.test.ts` "isRateLimited returns false after expiry" | Phase 5 Step 5.1 |
| AC5.3 | `model-resolution.test.ts` "falls back to alternative when primary backend is rate-limited (AC5.3)" | Phase 5 Step 5.1 |
| AC5.4 | `model-router.test.ts` "listEligible excludes rate-limited backends" + `model-resolution.test.ts` AC2.4 | Phase 5 Step 5.1 |
| AC6.1 | `ollama-driver.test.ts` "calling the same tool twice produces distinct IDs" | Phase 6 Step 6.1 |
| AC6.2 | `openai-driver.test.ts` two AC6.2 tests | Phase 6 Step 6.1 |
| AC6.3 | `agent-loop.test.ts` "Anthropic native tool IDs are passed through unchanged" | Phase 6 Step 6.1 |
| AC6.4 | `agent-loop.test.ts` "handles 3+ duplicate tool-use IDs correctly" | Phase 6 Step 6.1 |
| AC7.1 | `relay-router.test.ts` "object-format HostModelEntry is parsed" | E2E Mixed-Format Hosts Step 2 |
| AC7.2 | `relay-router.test.ts` "excludes hosts lacking vision capability" | E2E Vision-Aware Cross-Host Relay Step 3 |
| AC7.3 | `relay-router.test.ts` "uses unverified hosts as fallback" | E2E Mixed-Format Hosts Step 3 |
| AC7.4 | `relay-router.test.ts` "handles mixed string/object entries" | E2E Mixed-Format Hosts Step 2 |
| AC7.5 | `discord-attachment.test.ts` inline + file_ref + text-only tests | Phase 1 Steps 1.1–1.3 |
