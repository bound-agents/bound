# Cache-Stable Prefix Design

## Summary

This design introduces a cache-stable prefix architecture for the agent loop to improve prompt cache efficiency with Anthropic and Bedrock LLM backends. The current implementation rebuilds the entire context from the database on every loop invocation, shifting message positions and invalidating byte-for-byte cache matches. The solution maintains a warm-path append-only message history: between loop iterations, the agent reuses the previous turn's message array and only appends new messages, preserving the cached prefix. Volatile enrichment (memory deltas, task digests, cross-thread summaries) is relocated from the system prompt blocks to a `developer`-role message at the tail of the array, so it never invalidates cached segments when it changes.

Two new LLM message roles are introduced: `developer` for contextual instructions and `cache` as a zero-content marker for cache checkpoint placement. The warm path checks cache prediction, tool fingerprint stability, and context budget before reusing stored state. The cold path performs a full `assembleContext()` rebuild when the cache is expired, tools change, or the context exceeds a high-water mark. Four cache checkpoints are allocated (1+1+1+1): system prompt, tool definitions, a fixed message boundary set on cold-path assembly, and a rolling checkpoint that advances each warm-path turn. This approach is provider-agnostic — Bedrock and Anthropic get explicit cache markers, while OpenAI and Ollama benefit from the stable prefix for automatic prefix matching.

## Definition of Done

1. **Append-only message history while cache is warm**: Between agent loop invocations, the loop reuses the previous turn's messages and only appends new ones. No reassembly from scratch. cachePoints accumulate (up to the 4-per-request provider limit) rather than being recomputed from `length - 2` each time.

2. **System suffix moved out of cached prefix**: The volatile enrichment (~17k tokens of memory deltas, task digests, cross-thread digest, etc.) is relocated from the system prompt blocks to the end of the messages array (after all cachePoints), so it never invalidates the Bedrock message-level cache when it changes between loop invocations.

3. **Cold/high-water full reassembly**: When `predictCacheState()` returns cold (TTL expired) or the context exceeds a high-water mark, a full `assembleContext()` rebuild runs with truncation and a fresh single cachePoint. This is the only path that mutates the cached prefix.

4. **Provider-agnostic stable prefix**: Bedrock and Anthropic get multiple cachePoint/cache_control markers. OpenAI-compatible and Ollama get the same append-only behavior (stable prefix for automatic prefix matching) but no explicit cache markers.

5. **Unit tests enforcing the invariants**: Tests that verify prefix stability across simulated loop invocations, cachePoint accumulation, correct cold/warm path selection, and high-water mark behavior.

6. **High-water mark headroom**: The initial cold-path assembly must produce a context that leaves enough room for the warm path to append multiple turns of messages before hitting the high-water mark. The high-water mark must be set so that normal tool-use turns (~2 messages per turn) don't constantly trigger reassembly.

## Acceptance Criteria

### cache-stable-prefix.AC1: Append-only message history while warm
- **cache-stable-prefix.AC1.1 Success:** Warm-path turn reuses stored messages and appends only new ones; no full reassembly occurs
- **cache-stable-prefix.AC1.2 Success:** Messages[0..fixedCP] are byte-identical (via stableStringify) across 5 consecutive warm-path turns
- **cache-stable-prefix.AC1.3 Success:** Fixed cache message stays at same index across warm turns; rolling cache message advances by 2 each turn
- **cache-stable-prefix.AC1.4 Failure:** Cold path fires when no stored state exists (first invocation)
- **cache-stable-prefix.AC1.5 Edge:** Thread with only 1 message skips cache message placement (fewer than 2 messages)

### cache-stable-prefix.AC2: System suffix moved out of cached prefix
- **cache-stable-prefix.AC2.1 Success:** Volatile enrichment appears as a `developer`-role message at the tail of the messages array, after all `cache` messages
- **cache-stable-prefix.AC2.2 Success:** Bedrock request system blocks contain only `[prefix, cachePoint]` (no suffix block)
- **cache-stable-prefix.AC2.3 Success:** Anthropic request system blocks contain only `[{text, cache_control}]` (no suffix block)
- **cache-stable-prefix.AC2.4 Success:** `system_suffix` field removed from ChatParams; no driver references it
- **cache-stable-prefix.AC2.5 Success:** Volatile enrichment is freshly computed on every turn (warm and cold)

### cache-stable-prefix.AC3: Cold/high-water full reassembly
- **cache-stable-prefix.AC3.1 Success:** predictCacheState returning cold triggers full assembleContext rebuild
- **cache-stable-prefix.AC3.2 Success:** Context exceeding contextWindow on warm path triggers cold reassembly
- **cache-stable-prefix.AC3.3 Success:** Tool fingerprint change between turns triggers cold path
- **cache-stable-prefix.AC3.4 Success:** Cold path places single fixed cache message at messages[length-2]
- **cache-stable-prefix.AC3.5 Success:** Cold path stores CachedTurnState for subsequent warm turns

### cache-stable-prefix.AC4: Provider-agnostic stable prefix
- **cache-stable-prefix.AC4.1 Success:** Bedrock driver materializes `cache` messages as cachePoint blocks on previous message
- **cache-stable-prefix.AC4.2 Success:** Anthropic driver materializes `cache` messages as cache_control on previous message
- **cache-stable-prefix.AC4.3 Success:** OpenAI driver drops `cache` messages entirely
- **cache-stable-prefix.AC4.4 Success:** Ollama driver drops `cache` messages entirely
- **cache-stable-prefix.AC4.5 Success:** Bedrock driver maps `developer` to user-message prepend in `<system-context>` wrapper
- **cache-stable-prefix.AC4.6 Success:** Anthropic driver maps `developer` to user-message prepend in `<system-context>` wrapper
- **cache-stable-prefix.AC4.7 Success:** OpenAI driver passes `developer` as native role
- **cache-stable-prefix.AC4.8 Success:** Ollama driver maps `developer` to `system` role
- **cache-stable-prefix.AC4.9 Success:** Bedrock places cachePoint in toolConfig when cache messages present and tools non-empty
- **cache-stable-prefix.AC4.10 Success:** Anthropic places cache_control on last tool when cache messages present and tools non-empty

### cache-stable-prefix.AC5: Unit tests enforcing invariants
- **cache-stable-prefix.AC5.1 Success:** Tests exist for each AC in AC1-AC4 and AC6
- **cache-stable-prefix.AC5.2 Success:** Existing test suites pass with no regressions

### cache-stable-prefix.AC6: High-water mark headroom
- **cache-stable-prefix.AC6.1 Success:** Cold-path assembly targets 0.85 of contextWindow
- **cache-stable-prefix.AC6.2 Success:** At 200k contextWindow, at least 20 warm-path turns (at ~500 tok/turn) fit before high-water triggers
- **cache-stable-prefix.AC6.3 Failure:** Initial cold-path assembly on a long thread does not immediately exceed contextWindow (truncation handles it)
- **cache-stable-prefix.AC6.4 Edge:** Thread that grows rapidly (large tool results) triggers cold reassembly within a few turns rather than overflowing

## Glossary

- **Prompt caching**: LLM provider feature that reuses computation from prior requests by matching a byte-for-byte identical prefix of the input, reducing token processing costs and latency. Supported by Anthropic and AWS Bedrock.
- **cachePoint / cache_control**: Provider-specific cache markers. Bedrock uses `cachePoint` blocks in system/message/tool config; Anthropic uses `cache_control` metadata on content blocks. Both mark positions where the provider should store cached computation.
- **Warm/cold path**: The warm path reuses cached state (stored messages + append); the cold path is a full rebuild when the cache is expired, tools change, or the context overflows.
- **Volatile enrichment**: Contextual metadata that changes frequently between turns — memory deltas (L0-L3), task digests, cross-thread summaries, file notifications, runtime metadata. Currently ~17k tokens.
- **Tool fingerprint**: A hash representing the current set of tool definitions. Changes invalidate cached context and force a cold-path rebuild.
- **TTL (Time To Live)**: Duration for which cached data is valid. 5-minute for high-frequency interfaces, 1-hour for sparse interfaces (Discord, scheduler).
- **MCP (Model Context Protocol)**: Protocol for external tools to integrate with LLM applications. Bound bridges MCP servers as subcommands.
- **High-water mark**: Threshold that triggers transition from warm path (append-only) to cold path (full rebuild).
- **TRUNCATION_TARGET_RATIO**: The 0.85 constant defining the cold path's context budget — 85% of context window, leaving 15% headroom for warm-path growth.
- **Developer role**: New LLM message role for contextual instructions that aren't the core system prompt. Drivers map to provider-specific equivalents.
- **Cache role**: Zero-content marker message that drivers materialize as provider-specific cache markers or drop entirely.
- **Strands SDK**: Reference SDK for building AI agents on AWS Bedrock. Bound's toolConfig cachePoint pattern follows this SDK's approach.

## Architecture

### Problem

Bedrock and Anthropic prompt caching works by matching a byte-for-byte prefix of the request. When the prefix is identical across calls, the provider reads from cache instead of reprocessing. The current agent loop calls `assembleContext()` from scratch on every loop invocation, which rebuilds the full message array from the DB. New messages from the previous loop's tool execution shift every subsequent message's position by 2, invalidating the entire message-level cache. This produces a ~15:85 read:write ratio despite the message content being logically identical.

A secondary issue: Bedrock includes all system content (including content after a system-level cachePoint) in message-level cache keys. The volatile enrichment (~17k tokens of memory deltas, task digests, etc.) currently lives in `system[2]` (after the system cachePoint). When it changes between loop invocations, all message-level cachePoints miss.

### Two New Message Roles

The agent loop introduces two new roles in `LLMMessage`:

- **`developer`**: Contextual instructions that aren't the core system prompt. Used for volatile enrichment, model-switch notifications, scheduler task context, and truncation markers. Drivers map this to the provider-specific equivalent: OpenAI passes it natively as `developer`, Anthropic/Bedrock prepend it to the next user message in a `<system-context>` wrapper, Ollama maps to `system`.

- **`cache`**: Zero-content marker that drivers materialize as a cachePoint (Bedrock) or cache_control (Anthropic), or drop entirely (OpenAI/Ollama). Placed directly in the message stream at positions where cache checkpoints should go.

These roles let the agent loop express generic intent while drivers handle provider-specific constraints (alternation rules, role support, cache marker format).

### Warm/Cold Path Selection

The agent loop stores the previous turn's assembled state on the instance:

```typescript
interface CachedTurnState {
  messages: LLMMessage[];
  systemPrompt: string;
  cacheMessagePositions: number[];
  fixedCacheIdx: number;
  lastMessageCreatedAt: string;
  toolFingerprint: string;
}
```

Before each outer loop iteration:

1. Call `predictCacheState(db, threadId, ttlMs)`.
2. If **warm** and stored state exists: check tool fingerprint unchanged, estimate total with new messages against contextWindow. If both pass, take the warm path. Otherwise fall through to cold.
3. **Warm path**: Fetch new messages from DB (by `created_at > lastMessageCreatedAt`), append to stored array, advance rolling cache message, compute fresh volatile enrichment and inject as `developer` message at tail. Store updated state.
4. **Cold path**: Full `assembleContext()`, extract volatile enrichment into `developer` message tail (not system_suffix), place fixed cache message at `messages.length - 2`, store state. The cold path targets `TRUNCATION_TARGET_RATIO` (0.85) of contextWindow, leaving 15% headroom for warm-path growth.

### cachePoint Allocation (1+1+1+1)

Four cache checkpoints, one per provider slot:

| Slot | What | Placement | Lifetime |
|------|------|-----------|----------|
| CP1 | System prompt | System blocks (persona, orientation) | Stable across all turns |
| CP2 | Tool definitions | toolConfig (Bedrock) / last tool (Anthropic) | Stable within thread; tool change triggers cold path |
| CP3 (fixed) | Cold-path boundary | Set on cold path at `messages[length - 2]`, never moves while warm | Until next cold reassembly |
| CP4 (rolling) | Recent messages | Advances to `messages[length - 2]` each warm-path turn | Refreshed each turn |

The fixed checkpoint (CP3) provides a stable fallback. Even if CP4's cached segment expires (5-minute TTL between turns), the prefix up to CP3 remains cached. The rolling checkpoint (CP4) caches the most recent segment for back-to-back turns.

Tool caching is implicit: if any `cache` messages exist in the stream and the provider supports tool caching (Bedrock/Anthropic), tools are cached. If the tool segment is below the 1024-token minimum, the provider silently skips it.

### Volatile Enrichment

Volatile enrichment is extracted from `assembleContext()` into a standalone function:

```typescript
interface VolatileContext {
  content: string;
  tokenEstimate: number;
}

function buildVolatileContext(params: {
  db: Database;
  threadId: string;
  taskId?: string;
  siteId: string;
  hostName: string;
  currentModel: string;
  userId?: string;
  relayInfo?: RelayInfo;
  platformContext?: PlatformContext;
  systemPromptAddition?: string;
}): VolatileContext
```

This produces the same content currently built in Stage 5.5 (memory deltas L0-L3, task digest, cross-thread digest, file notifications, skills index, advisory/retirement notifications) plus the per-turn metadata (user/thread IDs, relay info, platform context, model name, system prompt addition).

The result is injected as a `developer` message at the tail of the messages array, after all `cache` messages. It is recomputed on every turn (both warm and cold paths) so it's always fresh. Since it's after all cache checkpoints, it never invalidates any cached segment.

### System/Non-System Split Removal

The current agent loop filters system messages out of the array and joins them into a `systemPrompt` string:

```typescript
const systemMessages = llmMessages.filter(m => m.role === "system");
const nonSystemMessages = llmMessages.filter(m => m.role !== "system");
const systemPrompt = systemMessages.map(...).join("\n\n");
```

This is removed. The agent loop passes the full message array to the driver, with the system prompt as a separate `system` parameter (the stable persona + orientation content only). The `system_suffix` parameter is eliminated. `Scheduler.runTask` switches from `system` to `developer` role for its injected context. Model-switch messages and truncation markers also use `developer`.

### ChatParams Changes

```typescript
interface ChatParams {
  model?: string;
  messages: LLMMessage[];       // now includes developer and cache roles
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  system?: string;              // stable system prompt only
  // system_suffix removed
  // cache_breakpoints removed
  thinking?: { type: "enabled"; budget_tokens: number };
  signal?: AbortSignal;
}
```

Drivers are responsible for:
- Extracting and materializing `cache` messages into provider-specific markers
- Mapping `developer` messages to the provider-specific form
- Placing tool cachePoints when `cache` messages are present
- Enforcing provider alternation rules after role mapping

### Driver Mapping

| Role | Bedrock | Anthropic | OpenAI | Ollama |
|------|---------|-----------|--------|--------|
| `developer` | Prepend to next user message content | Prepend to next user message content | Native `developer` role | Map to `system` role |
| `cache` | Append `{ cachePoint: { type: "default" } }` to previous message's content | Add `cache_control: { type: "ephemeral" }` to previous message | Drop | Drop |

## Existing Patterns

### Cache Prediction (`packages/agent/src/cache-prediction.ts`)

`predictCacheState(db, threadId, ttlMs)` already exists and returns `"warm"` or `"cold"` based on the most recent turn's cache metrics and timestamp. `selectCacheTtl(threadInterface)` chooses 5-minute or 1-hour TTL based on interface type (sparse interfaces like Discord/scheduler use 1h). This design uses these functions directly.

### Context Assembly (`packages/agent/src/context-assembly.ts`)

The 8-stage pipeline (MESSAGE_RETRIEVAL through METRIC_RECORDING) remains the cold-path implementation. The warm path bypasses it entirely, using stored state + DB delta instead. The volatile enrichment extraction (Stage 5.5) is factored out into a standalone function that both paths call.

### Truncation (`TRUNCATION_TARGET_RATIO = 0.85`)

The existing 15% headroom ratio was designed to keep cached prefixes stable and compensate for tokenizer underestimation. This design leverages it directly: cold-path assembly targets 85% of contextWindow, warm-path appends into the remaining 15%.

### Strands SDK Pattern (`strands-agents/sdk-python`)

The Bedrock toolConfig cachePoint pattern (placing a cachePoint marker inside the toolConfig alongside the tools array) follows the approach used by the Strands Agents SDK.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Developer and Cache Message Roles

**Goal:** Introduce `developer` and `cache` roles to `LLMMessage` and update all four drivers to handle them.

**Components:**
- `LLMMessage.role` union in `packages/shared/src/types.ts` or `packages/llm/src/types.ts` — add `"developer"` and `"cache"`
- `toBedrockMessages()` in `packages/llm/src/bedrock/convert.ts` — map `developer` to user-message prepend, materialize `cache` as cachePoint on previous message, drop both from output
- `toAnthropicMessages()` in `packages/anthropic-driver.ts` — same mapping for `developer`, materialize `cache` as cache_control on previous message
- OpenAI driver in `packages/llm/src/openai-driver.ts` — pass `developer` natively, drop `cache`
- Ollama driver in `packages/llm/src/ollama-driver.ts` — map `developer` to `system`, drop `cache`
- `validateBedrockRequest()` in `packages/llm/src/bedrock/validate.ts` — accept cachePoint blocks that were injected by the converter
- Tool caching: Bedrock places cachePoint in toolConfig when `cache` messages present; Anthropic places cache_control on last tool

**Dependencies:** None

**Done when:** All four drivers correctly map `developer` and `cache` roles. Existing driver tests pass. New tests verify role mapping per driver, tool caching placement, and that `cache` messages are dropped for OpenAI/Ollama.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Volatile Enrichment Extraction

**Goal:** Factor volatile enrichment out of `assembleContext()` into a standalone function callable by both warm and cold paths.

**Components:**
- `buildVolatileContext()` extracted from Stage 5.5 logic in `packages/agent/src/context-assembly.ts` — produces `VolatileContext { content, tokenEstimate }`
- `assembleContext()` refactored to call `buildVolatileContext()` internally and return its result as a `developer`-role message in the messages array (tail position) instead of as `systemSuffix`
- `ChatParams.system_suffix` removed from `packages/llm/src/types.ts`
- System block construction in both drivers simplified (no more three-block `[prefix, cachePoint, suffix]` layout; just `[prefix, cachePoint]`)

**Dependencies:** Phase 1 (drivers must handle `developer` role)

**Done when:** `assembleContext()` returns messages with a `developer` tail instead of `systemSuffix`. `system_suffix` removed from ChatParams. Drivers produce identical Bedrock/Anthropic requests (volatile content now in message tail instead of system blocks). All existing context assembly tests updated and passing.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: System/Non-System Split Removal

**Goal:** Remove the system message filtering in `AgentLoop.run()` and switch scheduler/model-switch/truncation markers to `developer` role.

**Components:**
- `AgentLoop.run()` in `packages/agent/src/agent-loop.ts` — remove `systemMessages`/`nonSystemMessages` split, pass full message array to drivers, pass system prompt as separate `system` param
- `Scheduler.runTask()` — change injected context messages from `system` to `developer` role
- Model-switch messages in agent-loop.ts — change from `system` to `developer` role
- Truncation marker in context-assembly.ts — change from `system` to `developer` role
- Context assembly system message construction — stable system prompt (persona + orientation) passed via `system` param, not as messages

**Dependencies:** Phase 2 (volatile enrichment must be a developer message before removing the split)

**Done when:** Agent loop passes full message array without filtering. Scheduler uses `developer` role. Model-switch and truncation markers use `developer`. System prompt passed via `system` param only. All agent loop tests pass.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Stored Prefix and Warm Path

**Goal:** Implement the warm-path logic in the agent loop — stored turn state, append-only message growth, cache message accumulation.

**Components:**
- `CachedTurnState` interface and instance storage on `AgentLoop` in `packages/agent/src/agent-loop.ts`
- Warm-path branch: reuse stored messages, fetch delta from DB, append, advance rolling `cache` message, inject fresh volatile `developer` tail
- Cold-path branch: full `assembleContext()` as before, place fixed `cache` message, store state
- `predictCacheState()` integration at the top of the outer loop
- Tool fingerprint computation and change detection (triggers cold path)

**Dependencies:** Phase 3 (agent loop must pass full message array without system split)

**Done when:** Agent loop selects warm/cold path based on cache prediction. Warm path reuses stored prefix and appends only new messages. Cold path does full assembly and stores state. Tool change forces cold path. Cache messages accumulate correctly (fixed stays, rolling advances).
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: High-Water Mark and Headroom

**Goal:** Implement the context budget check that triggers cold reassembly when warm-path growth exceeds the context window.

**Components:**
- Token estimation for warm-path total: stored tokens + new message tokens + volatile tokens + tool tokens
- High-water check: if estimated total exceeds contextWindow, fall through to cold path
- Cold-path headroom: verify assembly targets TRUNCATION_TARGET_RATIO (0.85), leaving room for warm growth
- Edge case: initial assembly already near limit (long thread on first cold start)

**Dependencies:** Phase 4 (warm/cold path selection must exist)

**Done when:** Warm path checks budget before appending. Exceeding contextWindow triggers cold reassembly. Cold path leaves 15% headroom. Tests verify at least 20 warm-path turns fit at 500 tok/turn before high-water triggers on a 200k context window. Tests verify that initial cold-path assembly doesn't immediately exceed the high-water mark.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Integration Tests and Cache Stability Verification

**Goal:** End-to-end verification that the cache-stable prefix produces the expected read:write improvement.

**Components:**
- Extend `packages/llm/src/__tests__/cache-stability.test.ts` with multi-turn warm-path prefix stability tests
- Agent loop integration tests simulating multiple loop invocations with warm cache
- Per-driver tests for `cache` message materialization (cachePoint placement, tool caching)
- Per-driver tests for `developer` message mapping
- Debug logging (`BOUND_DEBUG_BEDROCK_CACHE`) updated to report warm/cold path selection and cachePoint positions

**Dependencies:** Phase 5 (full warm/cold implementation must be complete)

**Done when:** All existing tests pass with no regressions. New tests verify: prefix byte-stability across warm turns, cachePoint accumulation (1+1+1+1 allocation), cold trigger on tool change, cold trigger on high-water, headroom guarantee, volatile enrichment freshness on warm path, correct driver mapping for all 4 providers.
<!-- END_PHASE_6 -->

## Additional Considerations

**Bedrock vs Anthropic cache key semantics differ:** Bedrock includes all system content (even after system cachePoint) in message-level cache keys. Anthropic does not. Moving volatile content to the message tail (as a `developer` message after all `cache` messages) solves both — it's never part of any cached segment regardless of provider semantics.

**4 cachePoint limit:** Both Bedrock and Anthropic allow at most 4 cache checkpoints per request. The 1+1+1+1 allocation (system + tools + fixed + rolling) uses all 4 slots. If a future provider allows more, the rolling slot count could increase.

**1024-token minimum:** Cached segments below 1024 tokens are silently ignored by both providers. The system prompt (~5k tokens) and tool schemas (varies, often >1k with MCP tools) easily clear this. The fixed message checkpoint may be below threshold on very short threads — the provider handles this gracefully.

**Relay (remote inference):** The relay path in agent-loop.ts sends `InferenceRequestPayload` to the hub. The payload currently includes `cache_breakpoints` and `system_suffix`. These fields need to be updated: `cache_breakpoints` removed (cache messages are in the message array), `system_suffix` removed (volatile content is a developer message). The hub's relay processor should pass the message array through to the remote driver as-is.
