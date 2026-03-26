# Inference Relay Design

## Summary

This design enables cluster-wide LLM inference sharing via the existing relay transport. Any Bound host can request inference from another host's LLM backends, receiving streamed responses transparently through the same parsing pipeline used for local calls. The model router resolves model IDs cluster-wide, distinguishing local backends (direct `chat()` call) from remote ones (relay through hub). When the agent loop requests inference with a remote model, it enters a new RELAY_STREAM state that writes an `inference` message to the relay outbox, polls for `stream_chunk` responses ordered by sequence number, and yields them as an `AsyncIterable<StreamChunk>` indistinguishable from local inference. The target host's RelayProcessor executes the request against its local LLM backend, buffering chunks and flushing them to the outbox at 200ms intervals or 4KB thresholds. The hub routes these streaming responses back to the requester via eager push or the next sync cycle.

The design also introduces web UI loop delegation: when the selected model and the majority of recent tool calls originate from a single remote host, the orchestrator delegates the entire agent loop to that host via a `process` relay message. The processing host runs the loop and forwards activity status updates back to the originating host via `status_forward` messages, allowing the web UI to display thinking indicators and support cancellation as if processing were local. This avoids the round-trip overhead of individual relay calls for every tool execution when the remote host has both the model and the tooling required for the conversation.

## Definition of Done

1. **A host can request LLM inference from any other host in the cluster via the relay**, using the streaming `inference`→`stream_chunk`→`stream_end` protocol. The requesting host receives chunks as an `AsyncIterable<StreamChunk>` indistinguishable from a local inference call.

2. **The model router resolves models cluster-wide** — local models are called directly, remote models are routed through the relay. The web UI model selector shows all cluster models with host, relay, and liveness annotations.

3. **Web UI loop delegation** automatically delegates the entire agent loop to a remote host when all §5.6 conditions hold (model remote, single host, ≥50% tool match), with activity status forwarded back to the originating host and cancel propagated to the processing host.

4. **Tests validate the full stack** — unit tests for RELAY_STREAM state machine, model routing, and chunk buffering; integration tests for end-to-end streaming relay; Playwright e2e for model selection and loop delegation.

## Acceptance Criteria

### inference-relay.AC1: Streaming inference via relay
- **inference-relay.AC1.1 Success:** Requester writes `inference` request, target streams `stream_chunk` messages back, requester yields `StreamChunk`s from async generator
- **inference-relay.AC1.2 Success:** `stream_end` message closes the generator and provides usage stats to the caller
- **inference-relay.AC1.3 Success:** Chunks arrive ordered by `seq`; parser produces correct `ParsedResponse` (text + tool calls + usage) identical to local inference
- **inference-relay.AC1.4 Success:** Cancel during RELAY_STREAM sends `cancel` to target, target aborts the `AsyncIterable`, requester exits cleanly
- **inference-relay.AC1.5 Success:** Failover on per-host timeout — new `stream_id`, retry on next eligible host
- **inference-relay.AC1.6 Failure:** No chunks within `inference_timeout_ms` (default 120s) returns timeout error to agent loop
- **inference-relay.AC1.7 Failure:** Target model unavailable returns `error` kind response
- **inference-relay.AC1.8 Edge:** Out-of-order `seq` — chunks buffered, yielded when contiguous, gap skipped after 2 sync cycles with log warning
- **inference-relay.AC1.9 Edge:** Large prompt (>2MB serialized) triggers file-based sync; target reads prompt from synced file

### inference-relay.AC2: Cluster-wide model resolution
- **inference-relay.AC2.1 Success:** Local model resolves to `{ kind: "local", backend }` — no relay
- **inference-relay.AC2.2 Success:** Remote model resolves to `{ kind: "remote", hosts }` sorted by `online_at` recency
- **inference-relay.AC2.3 Success:** `model-hint` validates against cluster-wide model pool (local + remote)
- **inference-relay.AC2.4 Failure:** Unknown model (not in any host's `models`) returns error with available alternatives
- **inference-relay.AC2.5 Edge:** Host with matching model but stale `online_at` (> 2 x sync_interval) filtered from eligible hosts

### inference-relay.AC3: Target-side inference execution
- **inference-relay.AC3.1 Success:** Target receives `inference` request, calls local `chat()`, streams chunks back with correct `stream_id` and monotonic `seq`
- **inference-relay.AC3.2 Success:** Chunks flushed to outbox at 200ms timer OR 4KB buffer threshold (whichever fires first)
- **inference-relay.AC3.3 Success:** `stream_end` outbox entry carries final chunk batch including `done` chunk with usage stats
- **inference-relay.AC3.4 Success:** Cancel message aborts active inference stream via `AbortController`; target writes `error` response with `"cancelled by requester"`
- **inference-relay.AC3.5 Failure:** Expired request (past `expires_at`) discarded without execution
- **inference-relay.AC3.6 Edge:** Multiple concurrent inference streams execute simultaneously on same target without interference

### inference-relay.AC4: Metrics and observability
- **inference-relay.AC4.1 Success:** Relayed inference records `relay_target` (host_name) and `relay_latency_ms` (first-chunk latency) on turns
- **inference-relay.AC4.2 Success:** Local inference has NULL `relay_target` and `relay_latency_ms` (no regression)
- **inference-relay.AC4.3 Success:** `relay_cycles` records entries for `inference`, `stream_chunk`, `stream_end` kinds with `stream_id`

### inference-relay.AC5: Web UI model selector
- **inference-relay.AC5.1 Success:** `/api/models` returns union of local backends and remote models from `hosts.models`
- **inference-relay.AC5.2 Success:** Remote models annotated with host name and `"via relay"`
- **inference-relay.AC5.3 Success:** Stale remote models (host `online_at` > 2 x sync_interval) annotated `"offline?"`
- **inference-relay.AC5.4 Success:** Volatile context includes model location: `"You are: {model} (via {provider} on host {host}, relayed from {local})"`
- **inference-relay.AC5.5 Edge:** Same model ID on multiple remote hosts listed as separate entries with different host annotations

### inference-relay.AC6: Web UI loop delegation
- **inference-relay.AC6.1 Success:** Delegation triggers when: model remote, exactly one host has model, that host has >=50% of thread's recent tools
- **inference-relay.AC6.2 Success:** Processing host receives `process` message, starts agent loop for the thread
- **inference-relay.AC6.3 Success:** Activity status forwarded via `status_forward`; originating host serves it from `/api/threads/{id}/status`
- **inference-relay.AC6.4 Success:** Cancel on originating host sends `cancel` with `ref_id` matching `process`; processing host aborts loop
- **inference-relay.AC6.5 Failure:** Any condition from inference-relay.AC6.1 unmet — no delegation, run locally with individual relay calls
- **inference-relay.AC6.6 Edge:** Confirmed tools blocked on delegated loops; agent receives block error and adapts
- **inference-relay.AC6.7 Edge:** Thread with no tool call history — vacuous >=50% match — delegation proceeds

## Glossary

- **Async generator**: A JavaScript function that returns an `AsyncIterable`, allowing sequential iteration over values that arrive asynchronously. Used to yield streaming LLM response chunks.
- **Change-log outbox**: Pattern in Bound where database writes to synced tables are paired with changelog entries in a single transaction, enabling event-sourced sync across hosts.
- **Chunk**: A fragment of an LLM response received during streaming, carrying partial text, tool call data, or usage statistics. Represented as `StreamChunk` union type.
- **Discriminated union**: TypeScript type that combines multiple object types, each with a unique literal `kind` or `type` field for runtime differentiation.
- **Eager push**: Sync optimization where the hub proactively delivers relay messages to reachable spokes via HTTP POST instead of waiting for the next sync cycle.
- **Failover**: Automatic retry mechanism that switches to the next eligible host when the current host times out or errors during relay execution.
- **Hub**: Central Bound instance in spoke-and-hub topology that receives sync pushes from all spokes, aggregates data, and redistributes it during pull phases.
- **Idempotency key**: Unique identifier (typically SHA-256 hash of request parameters) used to deduplicate repeated requests. Intentionally omitted from inference requests due to non-deterministic LLM behavior.
- **LWW (Last-Write-Wins)**: Conflict resolution strategy for synced data where the entry with the latest `modified_at` timestamp wins during merge.
- **MCP (Model Context Protocol)**: Protocol for exposing tools and resources to language models. Bound bridges MCP servers as agent commands and routes cross-host tool calls through relay.
- **Orchestrator**: Component responsible for initiating agent loop execution, deciding whether to process locally or delegate to a remote host.
- **Quiescence**: Sync optimization that reduces sync frequency during periods of inactivity, resuming normal cadence when user interaction resumes.
- **Relay outbox/inbox**: Local-only tables (not synced) that store pending relay messages before transmission (outbox) and received messages awaiting processing (inbox).
- **Relay transport**: Store-and-forward messaging pattern in Bound's sync protocol, allowing cross-host RPC for MCP tool calls and (with this design) LLM inference.
- **Reachability tracker**: Component monitoring spoke availability for eager push, marking hosts offline after consecutive failures.
- **Spoke**: Non-hub Bound instance in cluster topology. Pushes changes to hub and pulls aggregated state.
- **Stream ID**: UUID identifying a multi-message streaming session in the relay. All `stream_chunk` and `stream_end` messages for a single inference request share one `stream_id`.
- **Volatile context**: Dynamic system prompt fragment injected during context assembly, containing current timestamp, model location, and host information.

## Architecture

### Approach: RELAY_STREAM with Shared Streaming Pipeline

The inference relay extends the existing MCP relay transport (request/response pattern) with a streaming pattern for LLM inference. The key architectural decision: RELAY_STREAM is a new top-level agent loop state that produces an `AsyncIterable<StreamChunk>` — the same type returned by local `LLMBackend.chat()`. This means the existing chunk-parsing pipeline (text accumulation, tool call extraction, usage stats) consumes both local and relayed streams identically.

The model router gains a `resolve()` method returning a discriminated union: `{ kind: "local", backend }` or `{ kind: "remote", hosts }`. Before entering LLM_CALL, the agent loop calls `resolve()`. Local models proceed to `chat()` as before. Remote models enter RELAY_STREAM, which writes an `inference` request to the relay outbox, polls the relay inbox for `stream_chunk`/`stream_end` responses grouped by `stream_id`, reorders by `seq`, handles gaps, and yields chunks as an async generator.

The target host's RelayProcessor handles `inference` requests by calling its local LLM backend's `chat()`, buffering chunks, and flushing them to the relay outbox at 200ms intervals or 4KB thresholds. Each flush produces a `stream_chunk` outbox entry with a monotonic `seq` number. The final flush produces a `stream_end` entry with usage stats.

Web UI loop delegation builds on this infrastructure. When the selected model and majority of recent tools are on the same remote host, the orchestrator delegates the entire agent loop via a `process` relay message. The processing host runs the loop and forwards activity status back to the originating host via `status_forward` messages, enabling the web UI to show thinking indicators and cancel support as if processing were local.

### Data Flow

```
Requester                    Hub                      Target
    |                         |                         |
    |-- inference request --> |                         |
    |   (relay_outbox)        |-- forward -----------> |
    |                         |   (eager push or sync)  |
    |                         |                         |-- chat() on local backend
    |                         |                         |
    |                         |   <-- stream_chunk --  |  (200ms / 4KB flush)
    |   <-- stream_chunk --  |                         |
    |   (yield to pipeline)   |   <-- stream_chunk --  |
    |   <-- stream_chunk --  |                         |
    |                         |   <-- stream_end ----  |
    |   <-- stream_end ----  |                         |
    |   (close generator)     |                         |
```

### Key Contracts

**Model resolution (ModelRouter):**

```typescript
type ModelResolution =
  | { kind: "local"; backend: LLMBackend }
  | { kind: "remote"; hosts: EligibleHost[] };

resolve(modelId: string, db: Database, localSiteId: string): ModelResolution;
```

**Inference request payload:**

```typescript
interface InferenceRequestPayload {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  cache_breakpoints?: number[];
  timeout_ms: number;
}
```

**Stream chunk/end payloads:**

```typescript
interface StreamChunkPayload {
  chunks: StreamChunk[];
  seq: number;
}

// StreamEndPayload has the same shape — the kind field distinguishes them
type StreamEndPayload = StreamChunkPayload;
```

**Process and status forward payloads:**

```typescript
interface ProcessPayload {
  thread_id: string;
  message_id: string;
  user_id: string;
  platform: string | null; // null = web UI delegation
}

interface StatusForwardPayload {
  thread_id: string;
  status: string;       // "idle" | "thinking" | "tool_call" | etc.
  detail: string | null; // e.g., tool name
  tokens: number;
}
```

## Existing Patterns

The design follows established relay patterns from the MCP relay implementation:

- **RELAY_WAIT polling loop** (`packages/agent/src/agent-loop.ts:415-560`): RELAY_STREAM mirrors this pattern — write outbox, trigger sync, poll inbox, handle cancel/failover. The key difference is streaming (multiple responses per request, ordered by `seq`) vs. single response.
- **`findEligibleHosts()`** (`packages/agent/src/relay-router.ts:24-69`): `findEligibleHostsByModel()` follows the same structure — query hosts table, filter by capability (`hosts.models` instead of `hosts.mcp_tools`), sort by `online_at` recency.
- **`createRelayOutboxEntry()`** (`packages/agent/src/relay-router.ts:86-106`): Extended with optional `stream_id` parameter for streaming messages.
- **RelayProcessor** (`packages/agent/src/relay-processor.ts`): The `inference` case follows the same pattern as `tool_call` — validate, check expiry, execute locally, write response to outbox.
- **`LLMBackend.chat()` → `AsyncIterable<StreamChunk>`** (`packages/llm/src/types.ts:1-4`): All four drivers (Anthropic, Bedrock, OpenAI-compatible, Ollama) already return async iterables. The RELAY_STREAM generator produces the same type.
- **`withSilenceTimeout()`** in agent-loop.ts: Wraps any `AsyncIterable<StreamChunk>` with a timeout. Works with relay streams identically to local streams.

No new patterns introduced. The inference relay is a streaming extension of the existing request/response relay using the same tables, same sync phase, same eager push, same idempotency infrastructure (minus idempotency keys for inference, per spec §3.6).

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Schema & Type Foundation

**Goal:** Add streaming support to relay tables and define all new types.

**Components:**
- Schema migration in `packages/core/src/schema.ts` — add `stream_id TEXT` column to `relay_outbox`, `relay_inbox`, `relay_cycles`; add stream-aware indexes
- Relay kind extensions in `packages/shared/src/types.ts` — add `inference`, `stream_chunk`, `stream_end`, `process`, `status_forward` to kind lists; define `InferenceRequestPayload`, `StreamChunkPayload`, `StreamEndPayload`, `ProcessPayload`, `StatusForwardPayload` types
- `RelayOutboxEntry` and `RelayInboxEntry` types gain `stream_id: string | null`
- `createRelayOutboxEntry()` in `packages/agent/src/relay-router.ts` gains optional `streamId` parameter
- CRUD helpers in `packages/core/src/relay.ts` — add `readInboxByStreamId()` for fetching stream chunks ordered by `received_at`

**Dependencies:** None (first phase)

**Done when:** Schema migration applies cleanly, types compile, existing relay tests still pass
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Model Resolution & Routing

**Goal:** Enable cluster-wide model resolution so the agent loop knows whether inference is local or remote.

**Components:**
- `findEligibleHostsByModel()` in `packages/agent/src/relay-router.ts` — queries `hosts.models` JSON array, filters by recency, sorts by `online_at` then outbox depth tiebreaker
- `ModelRouter.resolve()` in `packages/llm/src/model-router.ts` — returns `{ kind: "local", backend }` or `{ kind: "remote", hosts }` discriminated union
- Agent loop constructor change in `packages/agent/src/agent-loop.ts` — takes `ModelRouter` instead of `LLMBackend` (or both, for backward compat during migration)
- `model-hint` defineCommand in `packages/agent/src/commands/` — validates against cluster-wide model pool via `resolve()`

**Dependencies:** Phase 1 (types needed for EligibleHost)

**Covers:** inference-relay.AC2.1, AC2.2, AC2.3, AC2.4, AC2.5

**Done when:** `resolve()` returns local for configured backends and remote for models only in `hosts.models`; `findEligibleHostsByModel()` filters stale hosts correctly; model-hint validates cluster-wide
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: RELAY_STREAM State Machine

**Goal:** The agent loop can request inference from a remote host and receive streaming chunks transparently.

**Components:**
- `RELAY_STREAM` added to `AgentLoopState` in `packages/agent/src/types.ts`
- `relayStream()` async generator in `packages/agent/src/agent-loop.ts` — generates `stream_id`, writes `inference` outbox entry, triggers sync, polls inbox by `stream_id`, reorders by `seq`, handles gaps, yields `StreamChunk`s
- LLM_CALL integration — before calling `chat()`, check `modelRouter.resolve()`. If remote, call `relayStream()` instead. Feed result through `withSilenceTimeout()` and existing chunk accumulation
- Cancel handling — on abort, write `cancel` kind with `ref_id` pointing to original inference request
- Failover — on timeout per host, try next eligible host with new `stream_id`
- Activity status updates — `"connecting to {host} for {model}..."` then `"inference via {host} (streaming, {n} tokens)"`
- Large prompt handling — check serialized payload size, write to temp file + sync if >2MB, reference file path in relay message
- Metrics — record `relay_target` and `relay_latency_ms` (first-chunk latency) on turn

**Dependencies:** Phase 1 (schema/types), Phase 2 (model resolution)

**Covers:** inference-relay.AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7, AC1.8

**Done when:** Agent loop uses remote model transparently; streaming chunks arrive and parse correctly; cancel aborts the stream; failover tries next host; activity status updates throughout; large prompts handled via file reference
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Target-Side Inference Execution

**Goal:** A host can receive and execute inference requests from the relay, streaming response chunks back.

**Components:**
- `inference` case in `RelayProcessor.processEntry()` at `packages/agent/src/relay-processor.ts` — validate model availability and keyring, check expiry, resolve prompt (file ref or inline), call local `chat()`, buffer and flush chunks
- Chunk buffering/flushing — 200ms timer OR 4KB buffer threshold, whichever fires first. Each flush writes a `stream_chunk` outbox entry with `stream_id` and monotonic `seq`
- `stream_end` — final flush with `done` chunk containing usage stats
- Cancel handling — `Map<string, AbortController>` tracking active inference streams by `ref_id`. Cancel message aborts the `AsyncIterable`, writes `error` response
- Hub relay executor update in `packages/sync/src/relay-executor.ts` — dispatch `inference` kind to background (not synchronous fast-path)
- Concurrency — multiple inference streams can run simultaneously on the same target

**Dependencies:** Phase 1 (schema/types)

**Covers:** inference-relay.AC3.1, AC3.2, AC3.3, AC3.4, AC3.5, AC3.6

**Done when:** Target receives inference request, streams chunks back with correct `stream_id`/`seq`, flushes at 200ms/4KB cadence, cancel aborts mid-stream, expired requests discarded
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: End-to-End Streaming Integration

**Goal:** Validate the full requester → hub → target → hub → requester streaming path.

**Components:**
- Integration tests in `packages/agent/src/__tests__/relay-stream.integration.test.ts` — two-instance cluster (requester + target), mock LLM backend on target, verify chunks arrive in order
- Large prompt integration test — payload >2MB triggers file-based prompt, target reads from synced file
- Cancel integration test — requester aborts mid-stream, cancel reaches target, target stops
- Metrics integration — verify `relay_target` and `relay_latency_ms` recorded on turns after relayed inference
- `relay_cycles` recording — verify stream_chunk and stream_end entries logged with correct `stream_id`

**Dependencies:** Phase 3 (RELAY_STREAM), Phase 4 (target execution)

**Covers:** inference-relay.AC1.1, AC1.5, AC1.7, AC1.8, AC3.5, AC3.6, AC4.1, AC4.2

**Done when:** Full round-trip streaming works across two instances; large prompts handled; cancel propagates; metrics recorded
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Web UI Model Selector

**Goal:** Web UI shows cluster-wide model pool with relay and liveness annotations.

**Components:**
- `GET /api/models` in `packages/web/src/server/routes/status.ts` — aggregate local backends + remote models from `hosts` table. Return `host`, `via`, `status` fields per model
- Svelte model selector in `packages/web/src/client/` — render local models normally, remote models with "(via relay)" annotation, stale models dimmed with "(offline?)"
- Volatile context in context assembly (`packages/agent/src/context-assembly.ts`) — include `"You are: {model} (via {provider} on host {host}, relayed from {local_host})"` when inference is relayed
- Message annotation — set `host_origin` to processing host's hostname for relayed inference messages
- Playwright test — multi-host cluster, verify model selector shows local + remote + offline annotations

**Dependencies:** Phase 2 (model routing for resolution data)

**Covers:** inference-relay.AC5.1, AC5.2, AC5.3, AC5.4, AC5.5

**Done when:** Model selector displays cluster-wide models with correct annotations; volatile context reflects relay origin; Playwright validates UI rendering
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Web UI Loop Delegation

**Goal:** The orchestrator delegates entire agent loops to a remote host when conditions favor it, with full status forwarding and cancel support.

**Components:**
- Delegation decision logic in orchestrator (`packages/agent/src/`) — evaluate: model remote? single host? ≥50% recent tools on that host? If all hold, delegate via `process` message
- `process` message handling in RelayProcessor — receive `process`, look up user message by `thread_id` + `message_id`, start agent loop
- `status_forward` emission — processing host sends `status_forward` on every status change during delegated loop
- Status caching on originating host — ephemeral `Map<thread_id, StatusForwardPayload>` in web server, served from `/api/threads/{id}/status`
- Cancel propagation — originating host sends `cancel` with `ref_id` matching `process` message; processing host aborts agent loop
- Confirmed tool blocking — delegated loops cannot prompt for user confirmation; confirmed tools return block error
- Playwright tests — verify delegation occurs when conditions hold; verify status indicator shows remote processing; verify cancel works; verify response appears after sync

**Dependencies:** Phase 5 (streaming integration working), Phase 6 (model selector)

**Covers:** inference-relay.AC6.1, AC6.2, AC6.3, AC6.4, AC6.5, AC6.6, AC6.7

**Done when:** Delegation triggers correctly; processing host runs the loop; status forwards to originating host; cancel aborts delegated loop; confirmed tools blocked; Playwright validates the full flow
<!-- END_PHASE_7 -->

## Additional Considerations

**Prompt caching across hosts.** Provider-side caching (Anthropic, OpenAI prefix) works naturally — the cache lives on the provider's servers, keyed by prompt content. Multiple requesters relaying to the same target share the cache. Local KV-cache (Ollama) benefits from routing consistency — calls to the same model on the same host reuse GPU memory cache. The context assembly pipeline's prefix stability optimization benefits relayed inference identically to local.

**Streaming UX during delegation.** When the agent loop is delegated (Phase 7), the originating host does not receive token-level streaming. The user sees status indicators ("thinking", "tool_call") via `status_forward`, then the full response appears when the assistant message syncs via change_log. This is acceptable — delegation is a latency optimization for total round-trip time, not streaming fidelity.

**Inference idempotency.** Per spec §3.6, inference requests do NOT carry idempotency keys. LLM calls are non-deterministic and non-idempotent. Duplicate prevention is structural: one RELAY_STREAM per `stream_id`, retries generate new `stream_id`s.

**Quiescence interaction.** Quiescence reduces sync frequency, proportionally increasing relay latency. This is benign — quiescence activates when no user is interacting, so no interactive inference calls are in flight. On user resume, adaptive sync restores normal relay latency.
