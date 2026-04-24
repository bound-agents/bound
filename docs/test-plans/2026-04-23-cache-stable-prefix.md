# Human Test Plan: Cache-Stable Prefix

## Prerequisites
- Staging environment with `BOUND_DEBUG_BEDROCK_CACHE=1` environment variable set
- Access to the bound web UI or a terminal client (`boundless`)
- At least one Bedrock backend configured with prompt caching enabled
- At least one Anthropic backend configured (optional, for AC2.3 verification)
- `bun test --recursive` passing with 0 failures
- `bun run typecheck` clean
- `bun run lint` clean

## Phase 1: Bedrock Cache Hit Rate Verification

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start the bound service with `BOUND_DEBUG_BEDROCK_CACHE=1` and a Bedrock backend | Service starts, log output includes cache debug entries |
| 2 | Create a new thread via the web UI or `boundless` | Thread created successfully |
| 3 | Send an initial message: "What is the Fibonacci sequence?" | Agent responds; log shows `cache_write_tokens > 0` and `cache_read_tokens = 0` (cold write) |
| 4 | Send a follow-up: "Show me the first 20 numbers" | Agent responds; log shows `cache_read_tokens > 0` (warm read), indicating prefix cache hit |
| 5 | Send 3 more follow-up messages in sequence, waiting for each response | Each response log shows `cache_read_tokens` increasing monotonically; `cache_write_tokens` should be 0 or near-0 after the second turn |
| 6 | Verify in the `turns` table: `SELECT tokens_cache_read, tokens_cache_write FROM turns WHERE thread_id = '<threadId>' ORDER BY created_at` | `tokens_cache_read` increases across rows; `tokens_cache_write` drops to 0 after the first warm turn |

## Phase 2: System Block Shape Verification (Bedrock)

| Step | Action | Expected |
|------|--------|----------|
| 1 | With `BOUND_DEBUG_BEDROCK_CACHE=1` active, examine the cache debug log entry for any turn with cache messages present | Log entry shows `system` field with exactly 2 elements |
| 2 | Verify the first system element is `{text: "<system prompt content>"}` | First element is the stable system prompt text, no volatile content |
| 3 | Verify the second system element is `{cachePoint: {type: "default"}}` | No third suffix block exists; volatile enrichment is NOT in the system blocks |
| 4 | Verify that volatile enrichment (memory delta, task digest, thread metadata) appears as a `developer`-role message in the messages array, not in system blocks | Developer message is the last message in the array, containing thread ID and host metadata |

## Phase 3: System Block Shape Verification (Anthropic)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Configure an Anthropic backend and send a message on a thread with at least 2 existing messages | Agent responds via Anthropic |
| 2 | Use a request proxy (e.g., mitmproxy) or Anthropic API logging to capture the HTTP request body | Request body captured |
| 3 | Inspect the `system` field in the request payload | `system` is an array with exactly 1 element: `{type: "text", text: "<prompt>", cache_control: {type: "ephemeral"}}` |
| 4 | Confirm no second element exists (no suffix block) | System array length is 1 |

## Phase 4: Warm/Cold Path Transitions

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start a fresh thread and send a message | First turn uses cold path (full context assembly) |
| 2 | Send a follow-up message | Second turn uses warm path (only delta messages appended). Cache debug log should show prefix fingerprint unchanged. |
| 3 | Add a new MCP server to the configuration and reload (`boundctl config-reload`) | New tools registered, tool fingerprint changes |
| 4 | Send another message on the same thread | Cold path triggered due to tool fingerprint mismatch. Cache debug log shows fresh prefix fingerprint. |
| 5 | Send one more follow-up | Warm path resumes with the new tool fingerprint |

## Phase 5: Budget Headroom and Reassembly

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start a thread and have a 20+ turn conversation with short messages (~100 tokens each) | All turns complete without reassembly; warm path maintained throughout |
| 2 | On a new thread, send a message that triggers a large tool result (e.g., "Read the contents of a large file") | Agent responds with large tool output |
| 3 | Repeat 3-4 times on the same thread with large tool results | Within 3-6 turns, cache debug logs show a cold reassembly (context exceeded high-water mark) |
| 4 | After reassembly, send a short follow-up | Warm path resumes with freshly truncated prefix |

## End-to-End: Full Cache Lifecycle

**Purpose:** Validate the complete lifecycle from cold start through warm steady-state to forced reassembly and back to warm.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Start bound with `BOUND_DEBUG_BEDROCK_CACHE=1` | Service running |
| 2 | Create thread, send: "Help me write a Python web scraper" | Cold path: `cache_write > 0`, `cache_read = 0` |
| 3 | Send: "Add error handling" | Warm path: `cache_read > 0`, prefix fingerprint unchanged |
| 4 | Send: "Add retry logic with exponential backoff" | Warm path: `cache_read` increases, prefix stable |
| 5 | Send 2 more follow-ups | Warm path continues, cache hits stable |
| 6 | Run `boundctl config-reload` with a new tool added | Tool fingerprint changes |
| 7 | Send: "Now test the scraper" | Cold path triggered (tool fingerprint changed); new `cache_write > 0` |
| 8 | Send: "Fix any errors" | Warm path restored with new fingerprint |
| 9 | Send a message triggering very large tool output (e.g., `bash cat /usr/share/dict/words`) | Large tool result stored |
| 10 | Repeat large output 3-4 times | Budget exceeded, cold reassembly triggered |
| 11 | Send a short follow-up | Warm path restored after reassembly |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|-----------|-------|
| AC1.2 (production) | Mock backends in tests cannot verify real provider-side cache hashing | Phase 1 Steps 3-6 |
| AC2.2 (production) | AWS SDK constructs the final Bedrock Converse API request | Phase 2 Steps 1-3 |
| AC2.3 (production) | Anthropic SDK constructs the final HTTP request | Phase 3 Steps 1-4 |
| AC5.1 (meta) | Test-existence criterion, not a behavior test | Cross-reference coverage report |
| AC5.2 (no regressions) | Production behavioral regressions require live observation | Monitor cache hit rates and error rates for 24h |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 | warm-cold-path.test.ts | Phase 4 Step 2 |
| AC1.2 | cache-stability.test.ts | Phase 1 Steps 3-6 |
| AC1.3 | warm-cold-path.test.ts, cache-stability.test.ts | Phase 1 Steps 4-5 |
| AC1.4 | warm-cold-path.test.ts | Phase 4 Step 1 |
| AC1.5 | warm-cold-path.test.ts | N/A (edge case) |
| AC2.1 | context-assembly.test.ts | Phase 2 Step 4 |
| AC2.2 | bedrock-driver.test.ts | Phase 2 Steps 1-3 |
| AC2.3 | anthropic-driver.test.ts | Phase 3 Steps 1-4 |
| AC2.4 | agent-loop.test.ts, context-assembly.test.ts | Phase 2 Step 3 |
| AC2.5 | context-assembly.test.ts, warm-cold-path.test.ts | Phase 4 Steps 1-2 |
| AC3.1 | warm-cold-path.test.ts | Phase 4 Step 1 |
| AC3.2 | warm-cold-path.test.ts | Phase 5 Steps 2-3 |
| AC3.3 | cached-turn-state.test.ts, warm-cold-path.test.ts | Phase 4 Steps 3-4 |
| AC3.4 | warm-cold-path.test.ts | Phase 4 Step 1 |
| AC3.5 | warm-cold-path.test.ts | Phase 4 Steps 1-2 |
| AC4.1-AC4.10 | bedrock-driver.test.ts, anthropic-driver.test.ts, openai-driver.test.ts, ollama-driver.test.ts, cache-stability.test.ts | Phase 2, Phase 3 |
| AC5.1 | Meta-verified by coverage analysis | N/A |
| AC5.2 | `bun test --recursive` | Monitor 24h post-deploy |
| AC6.1-AC6.4 | warm-cold-path.test.ts, context-assembly.test.ts | Phase 5 |
