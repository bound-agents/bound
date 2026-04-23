# Test Requirements: Cache-Stable Prefix

## Automated Tests

| AC | Description | Test Type | Expected Test File | Phase |
|----|-------------|-----------|-------------------|-------|
| AC1.1 | Warm-path turn reuses stored messages and appends only new ones; no full reassembly occurs | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC1.2 | Messages[0..fixedCP] are byte-identical (via stableStringify) across 5 consecutive warm-path turns | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC1.2 | Prefix byte-stability at the driver level with cache messages across simulated warm turns | unit | `packages/llm/src/__tests__/cache-stability.test.ts` | 6 |
| AC1.3 | Fixed cache message stays at same index across warm turns; rolling cache message advances by 2 each turn | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC1.3 | CachePoint accumulation across warm turns (1 fixed + 1 rolling) at driver level | unit | `packages/llm/src/__tests__/cache-stability.test.ts` | 6 |
| AC1.4 | Cold path fires when no stored state exists (first invocation) | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC1.5 | Thread with only 1 message skips cache message placement (fewer than 2 messages) | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC2.1 | Volatile enrichment appears as a `developer`-role message at the tail of the messages array, after all `cache` messages | unit | `packages/agent/src/__tests__/context-assembly.test.ts` | 2 |
| AC2.2 | Bedrock request system blocks contain only `[prefix, cachePoint]` (no suffix block) | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 2 |
| AC2.3 | Anthropic request system blocks contain only `[{text, cache_control}]` (no suffix block) | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 2 |
| AC2.4 | `system_suffix` field removed from ChatParams; no driver references it | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 2 |
| AC2.4 | `system_suffix` field removed from ChatParams; no driver references it (Anthropic) | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 2 |
| AC2.4 | `system_suffix` field removed from ChatParams; agent loop does not pass it | unit | `packages/agent/src/__tests__/agent-loop.test.ts` | 2 |
| AC2.5 | Volatile enrichment is freshly computed on every turn (warm and cold) | integration | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 6 |
| AC3.1 | predictCacheState returning cold triggers full assembleContext rebuild | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC3.2 | Context exceeding contextWindow on warm path triggers cold reassembly | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 5 |
| AC3.3 | Tool fingerprint change between turns triggers cold path | unit | `packages/agent/src/__tests__/cached-turn-state.test.ts` | 4 |
| AC3.3 | Tool fingerprint change forces cold path in agent loop | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC3.4 | Cold path places single fixed cache message at messages[length-2] | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC3.5 | Cold path stores CachedTurnState for subsequent warm turns | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 4 |
| AC3.5 | After cold path, stored state enables warm path on next invocation | integration | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 6 |
| AC4.1 | Bedrock driver materializes `cache` messages as cachePoint blocks on previous message | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.1 | Bedrock cache message with no previous message is dropped (no crash) | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.1 | Bedrock cache message placement determinism via stableStringify | unit | `packages/llm/src/__tests__/cache-stability.test.ts` | 6 |
| AC4.2 | Anthropic driver materializes `cache` messages as cache_control on previous message | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC4.2 | Anthropic cache message with no previous message is dropped | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC4.3 | OpenAI driver drops `cache` messages entirely | unit | `packages/llm/src/__tests__/openai-driver.test.ts` | 1 |
| AC4.3 | OpenAI cache message between user messages: both preserved, cache gone | unit | `packages/llm/src/__tests__/openai-driver.test.ts` | 1 |
| AC4.4 | Ollama driver drops `cache` messages entirely | unit | `packages/llm/src/__tests__/ollama-driver.test.ts` | 1 |
| AC4.4 | Ollama cache message between user messages: both preserved, cache gone | unit | `packages/llm/src/__tests__/ollama-driver.test.ts` | 1 |
| AC4.5 | Bedrock driver maps `developer` to user-message prepend in `<system-context>` wrapper | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.5 | Bedrock developer with no subsequent user message creates new user message | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.5 | Bedrock multiple consecutive developer messages all prepended to next user message | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.6 | Anthropic driver maps `developer` to user-message prepend in `<system-context>` wrapper | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC4.6 | Anthropic developer with no subsequent user message creates user message | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC4.6 | Anthropic multiple consecutive developer messages | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC4.7 | OpenAI driver passes `developer` as native role | unit | `packages/llm/src/__tests__/openai-driver.test.ts` | 1 |
| AC4.7 | OpenAI developer message with array content extracted to text string | unit | `packages/llm/src/__tests__/openai-driver.test.ts` | 1 |
| AC4.8 | Ollama driver maps `developer` to `system` role | unit | `packages/llm/src/__tests__/ollama-driver.test.ts` | 1 |
| AC4.8 | Ollama developer with array content extracted to text | unit | `packages/llm/src/__tests__/ollama-driver.test.ts` | 1 |
| AC4.9 | Bedrock places cachePoint in toolConfig when cache messages present and tools non-empty | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.9 | Bedrock cache messages present but no tools: no toolConfig, no crash | unit | `packages/llm/src/__tests__/bedrock-driver.test.ts` | 1 |
| AC4.9 | Bedrock toolConfig cachePoint placement determinism via stableStringify | unit | `packages/llm/src/__tests__/cache-stability.test.ts` | 6 |
| AC4.10 | Anthropic places cache_control on last tool when cache messages present and tools non-empty | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC4.10 | Anthropic cache messages present but no tools: no crash | unit | `packages/llm/src/__tests__/anthropic-driver.test.ts` | 1 |
| AC5.1 | Tests exist for each AC in AC1-AC4 and AC6 | integration | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 6 |
| AC5.2 | Existing test suites pass with no regressions | integration | (full suite: `bun test --recursive`) | 6 |
| AC6.1 | Cold-path assembly targets 0.85 of contextWindow | unit | `packages/agent/src/__tests__/context-assembly.test.ts` | 5 |
| AC6.1 | TRUNCATION_TARGET_RATIO constant is 0.85 | unit | `packages/agent/src/__tests__/context-assembly.test.ts` | 5 |
| AC6.2 | At 200k contextWindow, at least 20 warm-path turns (at ~500 tok/turn) fit before high-water triggers | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 5 |
| AC6.3 | Initial cold-path assembly on a long thread does not immediately exceed contextWindow (truncation handles it) | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 5 |
| AC6.4 | Thread that grows rapidly (large tool results) triggers cold reassembly within a few turns rather than overflowing | unit | `packages/agent/src/__tests__/warm-cold-path.test.ts` | 5 |

## Human Verification

| AC | Description | Why Not Automatable | Verification Approach |
|----|-------------|--------------------|-----------------------|
| AC1.2 | Byte-identical prefix across 5 consecutive warm-path turns in production | Automated tests use mock backends; real Bedrock/Anthropic cache hit rates depend on provider-side hashing of the full request payload, including headers and metadata beyond our control | Deploy to staging with `BOUND_DEBUG_BEDROCK_CACHE=1`, run 5+ consecutive turns on a thread, confirm `cache_read_tokens` increases monotonically and `cache_write_tokens` drops to 0 after the first warm turn |
| AC2.2 | Bedrock request system blocks contain only `[prefix, cachePoint]` in production | Unit tests verify the conversion function output, but the actual Bedrock Converse API request structure is constructed by the AWS SDK and could differ from our internal representation | Enable `BOUND_DEBUG_BEDROCK_CACHE=1`, inspect logged request payloads, confirm system blocks have exactly 2 elements (text + cachePoint) with no suffix block |
| AC2.3 | Anthropic request system blocks contain only `[{text, cache_control}]` in production | Same as AC2.2 — the Anthropic SDK constructs the final HTTP request | Inspect Anthropic API request logs (or use a request proxy) to confirm system payload shape matches `[{type: "text", text: ..., cache_control: {type: "ephemeral"}}]` |
| AC5.1 | Tests exist for each AC in AC1-AC4 and AC6 | This is a meta-criterion about test existence, not behavior | After implementation, run `grep -c "AC[1-6]\." packages/*/src/__tests__/*.test.ts` and cross-reference against this document to confirm every AC has at least one test. Phase 6 Task 4 performs this sweep. |
| AC5.2 | Existing test suites pass with no regressions | While `bun test --recursive` runs automatically, confirming zero regressions in production behavior requires observing the deployed system | Run `bun test --recursive` and `bun run typecheck` and `bun run lint` after each phase. After full deployment, monitor cache hit rates and error rates for 24h to confirm no regressions. |

## Test File Summary

| Test File | New? | Primary ACs Covered |
|-----------|------|-------------------|
| `packages/llm/src/__tests__/bedrock-driver.test.ts` | No (extended) | AC4.1, AC4.5, AC4.9, AC2.2, AC2.4 |
| `packages/llm/src/__tests__/anthropic-driver.test.ts` | No (extended) | AC4.2, AC4.6, AC4.10, AC2.3, AC2.4 |
| `packages/llm/src/__tests__/openai-driver.test.ts` | No (extended) | AC4.3, AC4.7 |
| `packages/llm/src/__tests__/ollama-driver.test.ts` | No (extended) | AC4.4, AC4.8 |
| `packages/llm/src/__tests__/cache-stability.test.ts` | No (extended) | AC1.2, AC1.3, AC4.1, AC4.9 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | No (extended) | AC2.1, AC2.4, AC2.5, AC6.1 |
| `packages/agent/src/__tests__/agent-loop.test.ts` | No (extended) | AC2.4 |
| `packages/agent/src/__tests__/cached-turn-state.test.ts` | Yes | AC3.3 |
| `packages/agent/src/__tests__/warm-cold-path.test.ts` | Yes | AC1.1-AC1.5, AC3.1-AC3.5, AC6.2-AC6.4 |

## Phase-to-Test Mapping

| Phase | Test Files Modified/Created | Description |
|-------|---------------------------|-------------|
| 1 | bedrock-driver, anthropic-driver, openai-driver, ollama-driver, cache-stability | Driver role mapping for `developer` and `cache` |
| 2 | context-assembly, agent-loop, bedrock-driver, anthropic-driver, cache-stability | Volatile enrichment as developer message, system_suffix removal |
| 3 | context-assembly, agent-loop | Model-switch, truncation, scheduler messages to developer role |
| 4 | **cached-turn-state (new)**, **warm-cold-path (new)**, agent-loop | Warm/cold path selection, CachedTurnState, tool fingerprint |
| 5 | warm-cold-path, context-assembly | High-water mark budget check, headroom verification |
| 6 | cache-stability, warm-cold-path | Integration tests, multi-invocation cycles, full regression sweep |
