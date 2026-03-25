# RFC: Hub Relay — Unified Cross-Host Service Channel

**Supersedes:** `2026-03-20-base.md` §7.5, §10.8, §12.5, §13.4 endpoints
**Date:** 2026-03-25
**Status:** Draft

---

## 1. Problem Statement

### 1.1 The Addressability Assumption

The base spec's MCP proxy (§7.5) routes tool calls to remote hosts via a direct HTTP POST to `/api/mcp-proxy`, resolved from the target host's `sync_url`. This creates a hard dependency: **the target host must be addressable by the requesting host.**

This assumption breaks for three common deployment scenarios:

**NAT-only hosts.** A laptop on a home network behind a consumer router has no public IP and no stable hostname. It can reach the hub (outbound connections work), but nothing can reach it.

**Mobile and tethered hosts.** A laptop tethered to a phone changes IP addresses constantly. Even with a `sync_url`, it's stale within minutes.

**Corporate firewalls.** An office workstation behind a corporate firewall can establish outbound HTTPS to the hub but cannot accept inbound connections.

In all three cases, the host is a fully functional cluster member — it syncs, claims tasks, executes agent loops, and runs MCP servers — but its tools are unreachable via direct proxy.

### 1.2 The Same Problem Applies to LLM Backends

The addressability gap extends beyond MCP tools. The base spec's LLM backend protocol (§4.6) assumes every host can reach its own configured model backends. But the interesting deployments are heterogeneous:

- **Laptop** has Ollama with llama-3-70b (local GPU). No API keys.
- **Cloud-vm** has Bedrock credentials for claude-opus-4. No GPU.
- **Work-desktop** has an OpenAI-compatible endpoint on the corporate network.

Today, if the user is on laptop and wants claude-opus-4, they're out of luck — the model is configured on cloud-vm, not locally. Model hints (`model-hint bedrock/claude-opus-4`) only work if the model is available on the current host. The `hosts.models` table advertises what exists where, but there's no mechanism to USE a remote model.

### 1.3 Discord Is Pinned to One Host

The base spec (§10.8) pins the Discord bot to a single configured host. If that host goes offline, Discord messages queue silently until it reconnects. Other cluster hosts are fully operational but have no way to receive or send Discord messages. This is a single point of failure in a system that otherwise has none.

Worse, the natural fix — "run the bot on every host" — creates a duplication problem. Discord's Gateway delivers every event to ALL connected clients sharing a token. Three hosts with the same token means three responses to one DM.

The system will extend to other messaging platforms with a mix of connection semantics: exclusive delivery (Slack webhooks, Telegram webhooks — one receiver) and broadcast delivery (Discord, Matrix, Signal — all clients receive). A unified framework must handle both.

### 1.4 Internal Events Are Host-Local

The base spec's event system (§10.2) says "Custom events are local to the current host." When the agent calls `emit --event "project.review_complete"`, only the local host's scheduler sees it. An event-driven task matching that event on a remote host won't fire until the task syncs and the remote host's scheduler picks it up on its next poll — a 30-60 second delay.

With the relay already providing targeted cross-host messaging, event propagation is a natural extension: emit locally AND broadcast to other hosts via the relay, so remote event-driven tasks fire within one sync cycle instead of two.

### 1.5 Observation

The sync protocol already solves the addressability problem for data replication. Spokes initiate outbound connections to the hub, and data flows bidirectionally over that connection. If ALL cross-host service calls — tool execution, resource reads, prompt invocations, cache warming, AND inference — traveled through the same channel, addressability would be a non-issue and the model pool would be cluster-wide.

---

## 2. Proposal

### 2.1 Summary

Replace the direct HTTP proxy mechanism (§7.5) with a **hub relay** — a sideband message channel embedded in the sync protocol that carries ALL cross-host service calls. The relay handles two communication patterns:

**Request/response** — for MCP tool calls, resource reads, prompt invocations, and cache warming. The requester sends a request, the target executes and returns a single response.

**Streaming** — for LLM inference. The requester sends a prompt, the target streams response chunks back as a series of messages. The requester synthesizes a local `AsyncIterable<StreamChunk>` from the arriving batches, feeding the existing streaming pipeline as if the model were local.

No host needs to be directly addressable by any other host. The only requirement is that each host can reach the hub. For addressable hosts, the hub delivers messages eagerly via HTTP push as a latency optimization.

### 2.2 What This Replaces

The base spec's `/api/mcp-proxy` endpoint (§7.5) and `/api/file-fetch` endpoint (§4.3) are **deleted entirely**. There is no direct host-to-host proxy path. All cross-host service calls flow through the relay. This eliminates:

- The `/api/mcp-proxy` endpoint and its request/response format.
- The `/api/file-fetch` endpoint for cache warming.
- The proxy selection strategy based on `sync_state.last_sync_at` freshness.
- The per-host idempotency response cache (replaced by hub-level dedup + target-level cache).
- The ambiguous failure response for timed-out direct proxy calls.
- The per-host-only model availability constraint (§4.6, R-U11).
- The single-host Discord bot pinning (§10.8, `config/discord.json`).
- The host-local-only event emission (§10.2 `emit` command).

### 2.3 Design Principles

**One cross-host channel.** The relay carries tools, resources, prompts, files, AND inference. One code path, one authentication model, one routing framework.

**Reuse the sync channel, not the change_log.** Relay messages are ephemeral targeted messages, not replicated state. They do not enter the change_log, do not replicate to all hosts, and do not persist after delivery.

**The hub relays; it does not execute.** The hub forwards messages. It never executes MCP tools or runs inference on behalf of another host — unless the hub IS the target, in which case it executes locally.

**Streaming is batched, not per-token.** LLM inference produces hundreds of tiny stream chunks. Sending each as a separate relay message would be absurd overhead. Instead, the target host buffers chunks and flushes them in batches at each delivery opportunity (sync cycle or eager push). The batch size is determined by the transport's natural cadence, not by a fixed timer.

**Transparent to the agent.** The agent calls `github-create-issue` or the orchestrator routes an LLM call. Neither knows or cares whether the service is local or remote.

**Offline independence preserved.** No relay feature is on the critical path for local operation. A spoke with no hub connectivity is functionally identical to a single-host deployment from the base spec: local models, local MCP tools, local web UI, local tasks, and local persistence all work. The relay is purely additive — it extends what a host can reach, never gates what it already has. If a user's selected model is remote and the hub is unreachable, the system suggests local alternatives (R-O1) and the conversation continues on a local model.

---

## 3. Architecture

### 3.1 Relay Tables (Non-Replicated)

Two local-only tables on every host. NOT synced via the change_log — exchanged as a sideband during the sync protocol's relay phase (§3.4).

```sql
CREATE TABLE relay_outbox (
  id              TEXT PRIMARY KEY,    -- UUID
  stream_id       TEXT,                -- groups related messages (all chunks in one inference stream share a stream_id)
  target_site_id  TEXT NOT NULL,       -- intended recipient host
  kind            TEXT NOT NULL,       -- see §3.2
  ref_id          TEXT,                -- for responses: the originating request's id
  idempotency_key TEXT,                -- deterministic hash for dedup (§3.6)
  payload         TEXT NOT NULL,       -- JSON; max 2MB per message
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,       -- TTL; discard after this
  delivered       INTEGER DEFAULT 0    -- 1 = confirmed delivered, eligible for pruning
) STRICT;

CREATE INDEX idx_relay_outbox_target ON relay_outbox(target_site_id, delivered)
  WHERE delivered = 0;
CREATE INDEX idx_relay_outbox_stream ON relay_outbox(stream_id)
  WHERE stream_id IS NOT NULL AND delivered = 0;

CREATE TABLE relay_inbox (
  id              TEXT PRIMARY KEY,    -- UUID (same as the sender's outbox entry)
  stream_id       TEXT,
  source_site_id  TEXT NOT NULL,       -- who sent this
  kind            TEXT NOT NULL,
  ref_id          TEXT,
  idempotency_key TEXT,
  payload         TEXT NOT NULL,       -- JSON; max 2MB per message
  expires_at      TEXT NOT NULL,       -- TTL from sender; target discards after this
  received_at     TEXT NOT NULL,
  processed       INTEGER DEFAULT 0   -- 1 = orchestrator has handled this
) STRICT;

CREATE INDEX idx_relay_inbox_unprocessed ON relay_inbox(processed)
  WHERE processed = 0;
CREATE INDEX idx_relay_inbox_stream ON relay_inbox(stream_id, received_at)
  WHERE stream_id IS NOT NULL AND processed = 0;
```

Both tables are pruned aggressively — delivered outbox entries and processed inbox entries are hard-deleted (not tombstoned; these are local-only) after a short retention (default: 5 minutes).

**Inbox dedup:** All inserts into `relay_inbox` use `INSERT OR IGNORE` (SQLite) to handle duplicate delivery gracefully. Duplicates occur when eager push delivers a message and the subsequent sync cycle delivers it again (before the hub marks it as delivered). The PRIMARY KEY on `id` deduplicates naturally — the second insert is a no-op.

### 3.2 Message Kinds

The `kind` field identifies the operation. Kinds are grouped into requests and responses:

**Request kinds** (requester → target):

| Kind | Pattern | Description |
|---|---|---|
| `tool_call` | Request/response | MCP tool invocation |
| `resource_read` | Request/response | MCP resource read by URI |
| `prompt_invoke` | Request/response | MCP prompt invocation |
| `cache_warm` | Request/response | Fetch overlay files for cache |
| `inference` | Streaming | LLM inference call |
| `cancel` | Signal | Abort an in-progress operation on the target |
| `intake` | Signal | Platform event claim — hub deduplicates and routes via `process` |
| `process` | Signal | Hub dispatches a message to a host for agent loop processing |
| `platform_deliver` | Request/response | Deliver agent response to a host with the platform connector |
| `event_broadcast` | Signal | Cross-host event propagation for the `emit` defineCommand |
| `status_forward` | Signal | Forward activity status from processing host to originating host |

**Response kinds** (target → requester):

| Kind | Pattern | Description |
|---|---|---|
| `result` | Request/response | Successful completion with payload |
| `error` | Both | Error (terminal for request/response, terminal for streaming) |
| `stream_chunk` | Streaming | Batch of inference stream chunks |
| `stream_end` | Streaming | Final message: last chunks + usage stats |

**Stream grouping:** All messages belonging to a single streaming inference call share the same `stream_id` (a UUID generated by the requester and included in the `inference` request). The target copies this `stream_id` onto every `stream_chunk` and `stream_end` it produces. The requester collects chunks by `stream_id` and feeds them to its local streaming pipeline in order.

### 3.3 Message Payloads

#### Request/Response Payloads

Payloads carry operation-specific fields only. The requesting host's identity is NOT in the payload — it travels in the relay envelope (`source_site_id` on inbox entries, populated from the sender's `site_id` during the sync handshake). This avoids redundancy and prevents spoofing (the envelope identity is authenticated; a payload field would not be).

**Tool call request:**

```json
{
  "tool": "github-create-issue",
  "args": { "repo": "acme/app", "title": "bug in auth" },
  "timeout_ms": 30000
}
```

**Resource read request:**

```json
{
  "resource_uri": "github://repos/acme/app/readme",
  "timeout_ms": 30000
}
```

**Prompt invocation request:**

```json
{
  "prompt_name": "github:summarize-pr",
  "prompt_args": { "repo": "acme/app", "pr_number": 42 },
  "timeout_ms": 30000
}
```

**Cache-warm request:**

```json
{
  "paths": ["/mnt/home-desktop/projects/nexus/src/routes/*.ts"],
  "timeout_ms": 60000
}
```

**Result response:**

```json
{
  "stdout": "{\"url\": \"https://github.com/acme/app/issues/99\"}",
  "stderr": "",
  "exit_code": 0,
  "execution_ms": 1847
}
```

**Error response:**

```json
{
  "error": "MCP server 'github' is not connected on this host",
  "retriable": false
}
```

**Process signal** (hub → processing host):

```json
{
  "thread_id": "thread-uuid",
  "message_id": "msg-uuid",
  "user_id": "user-uuid",
  "platform": "discord"
}
```

The `platform` field is `null` for web UI loop delegation (§5.6). The processing host uses `thread_id` and `message_id` to locate the user message and initiate the agent loop.

**Cancel signal** (requester → target): Payload is empty (`"{}"`). The `ref_id` field on the relay envelope identifies the operation to abort.

Additional payloads for `intake`, `platform_deliver`, `event_broadcast`, and `status_forward` are defined inline in §3.11, §3.12, and §3.13 respectively.

#### Streaming Payloads

**Inference request:**

```json
{
  "model": "bedrock/claude-opus-4",
  "messages": [ ... ],
  "tools": [ ... ],
  "system": "...",
  "max_tokens": 4096,
  "temperature": 0.7,
  "cache_breakpoints": [2, 15],
  "timeout_ms": 120000
}
```

This is the common message format from §4.6 of the base spec, forwarded verbatim. The target host's provider driver translates it to the provider's native API format, exactly as it would for a local inference call. The requester does NOT need to know which provider the target uses — it sends the common format and the target handles translation.

**Stream chunk response:**

```json
{
  "chunks": [
    { "type": "text", "content": "Here's what I found" },
    { "type": "text", "content": " in the codebase:\n\n" },
    { "type": "tool_use_start", "id": "tu_01", "name": "query" },
    { "type": "tool_use_args", "id": "tu_01", "partial_json": "{\"sql\":" }
  ],
  "seq": 3
}
```

The `chunks` array contains one or more `StreamChunk` objects (§4.6 of the base spec) batched together. The `seq` field is a monotonic counter per stream, enabling the requester to detect gaps and reorder if messages arrive out of order (possible with eager push racing sync delivery).

**Flush cadence on the target:** The target ALWAYS flushes buffered chunks on a short timer (default: 200ms) or when the buffer exceeds 4KB, writing each flush as a `stream_chunk` relay outbox entry. The flush timer is independent of the transport tier.

**Delivery cadence varies by transport:**

- **Sync polling (no eager push):** Multiple 200ms flushes accumulate in the hub's outbox between sync cycles. The requester receives them all in one batch on the next sync pull. At 5s adaptive sync, the requester gets ~25 chunk messages at once and processes them sequentially. The user sees tokens arrive in bursts.
- **Eager push:** The hub eager-pushes each 200ms flush to the requester immediately. ~200ms delivery granularity — smooth token display.

**Stream end response:**

```json
{
  "chunks": [
    { "type": "text", "content": "." },
    { "type": "done", "usage": { "input_tokens": 1847, "output_tokens": 423 } }
  ],
  "seq": 12
}
```

The `stream_end` message carries the final chunk batch (including the `done` chunk with usage stats) and signals that the stream is complete. After receiving `stream_end`, the requester closes its synthetic `AsyncIterable`.

### 3.4 Sync Protocol: Relay Phase

The base spec's sync exchange (§8.3) is spoke-initiated and three-phase: PUSH → PULL → ACK. This becomes four-phase: PUSH → PULL → ACK → RELAY.

```
1. PUSH     Spoke sends its change_log events to hub.
2. PULL     Spoke receives hub's change_log events (echo-suppressed).
3. ACK      Cursors advance.
4. RELAY    Bidirectional relay mailbox exchange.
   4a. Spoke sends:  all undelivered relay_outbox entries.
   4b. Hub sends:    all relay_inbox entries addressed to this spoke
                     (from other spokes, or from hub itself).
   4c. Spoke confirms receipt. Hub marks delivered.
```

The hub processes relay messages depending on the target:

- **Target is the hub itself (request/response — synchronous fast path):** For short-lived request/response kinds (`tool_call`, `resource_read`, `prompt_invoke`, `cache_warm`), the hub executes during the relay phase and returns the response in step 4b of the SAME sync connection — single round-trip.
- **Target is the hub itself (inference, intake, or platform_deliver — asynchronous):** Dispatched to the hub's background execution loop, NOT executed during the relay phase. `intake` triggers routing decisions and agent loops. `platform_deliver` involves external API calls (Discord, Slack) that could block on rate limits. `inference` involves model cold starts. None should hold open a sync connection. Results are delivered on subsequent sync cycles (or via eager push).
- **Target is another spoke:** Store in hub's relay_outbox with `target_site_id` preserved. Deliver on the target spoke's next sync cycle (step 4b), or immediately via eager push (§3.5) if the target is addressable.
- **Target is broadcast (`"*"`):** Used by `event_broadcast` only. The hub copies the message to the relay outbox for EVERY spoke except the originating host (echo suppression via `source_site_id`). Each copy gets the spoke's `site_id` as `target_site_id`. Eager push is attempted for addressable spokes.

The hub is the **only relay hop**. Spoke-to-spoke messages always travel: Spoke A → Hub → Spoke B.

### 3.5 Eager Push

When the hub receives a relay message — request or response, single or streaming — and the target spoke has a reachable `sync_url`, the hub immediately pushes the message via HTTP POST instead of waiting for the target's next sync poll. Eager push applies symmetrically to both directions (delivering requests to targets AND delivering responses back to requesters) and to both patterns (request/response AND streaming chunks).

**Decision rule:** The hub attempts eager push for EVERY relay message whose target spoke has `reachable = true` in the hub's per-spoke reachability table. If the push succeeds, the message is still delivered via the RELAY phase on the next sync as a redundant path (inbox dedup handles it). If the push fails, the message is delivered ONLY via sync. Eager push is additive — it never replaces sync delivery, only races it.

**Eager push endpoint:** Each host exposes `POST /api/relay-deliver` — accepts relay messages, inserts them into the local `relay_inbox`. Authenticated with Ed25519 (§8.4). Accepts ONLY messages from the current hub (verified by checking the signer's site_id).

**Streaming delivery:** For active inference streams, the target host flushes buffered chunks every 200ms (or at 4KB) regardless of transport tier. Each flush produces a `stream_chunk` relay message in the target's outbox. The hub eagerly pushes each chunk to the requester if addressable, giving ~200ms delivery granularity. For non-addressable requesters, chunks accumulate in the hub's outbox and are delivered in batch on the requester's next sync pull.

**Best-effort.** If the POST fails, the hub falls back to store-and-forward. No error is surfaced; delivery just takes longer.

**Reachability tracking:** The hub maintains a per-spoke `reachable` boolean, initialized to `true`. On every successful sync cycle or eager push, set to `true`. On every failed eager push, increment a failure counter. When the failure counter reaches `EAGER_PUSH_MAX_FAILURES` (default: 3 — enough to distinguish a transient blip from a genuine outage without wasting many HTTP attempts), set `reachable = false`. Reset the counter and set `reachable = true` on the next successful sync cycle. This is hub-local in-memory state, not persisted or replicated.

**Eager push is an internal hub optimization.** Invisible to both the requesting spoke and the target spoke.

### 3.6 Idempotency

**Request/response calls:** Every request carries an `idempotency_key` — a deterministic hash of `(kind, tool_or_model, args_hash, timestamp_rounded_to_60s)`. Enforced at two points: hub deduplication (rejects duplicate outbox pushes) and target idempotency cache (TTL: 5 minutes, in-memory; returns cached result without re-execution).

**Intake signals:** `intake` messages also carry an `idempotency_key` (`"intake:{platform}:{platform_event_id}"`), but dedup is hub-only — the hub checks its idempotency cache and discards duplicates before routing. There is no target-side cache because intake doesn't produce a response to the sender; it produces a `process` signal to a potentially different host.

**Inference calls:** Idempotency keys are NOT applied to inference requests. LLM calls are inherently non-deterministic (temperature > 0) and non-idempotent (different runs produce different text). Duplicate inference calls are prevented structurally: the requester generates a unique `stream_id` per call, and only one RELAY_STREAM sub-state exists per `stream_id` at a time. If the agent loop retries after a timeout, it generates a new `stream_id` — the retry is a genuinely new inference call, not a duplicate.

### 3.7 Payload Size Limits

Relay payloads are bounded at **2MB per message** (enforced at write time on outbox insert and inbox insert).

- **Tool call results:** Most under 100KB. 2MB handles outliers.
- **Resource reads:** Bounded by the overlay file size limit (1MB per §4.2).
- **Cache-warm responses:** The target splits multi-file responses into one relay message per file, each under 2MB. The requester reassembles by `ref_id`.
- **Inference requests:** The assembled context (§13.1 of the base spec) can exceed 2MB for large-context models (200k token contexts with long conversations). When the serialized inference request payload exceeds the 2MB relay limit, the requester writes the full prompt to a temporary file in the persistent workspace and syncs it via the normal change_log. The relay message containing the file reference is written to the outbox ONLY AFTER the sync cycle that delivers the file completes — this guarantees the file arrives at the target before the relay message that references it. (The file syncs to ALL hosts via change_log, but only the target reads it. The file is cleaned up by the requester after the inference call completes, and the tombstone propagates via sync.) This adds one sync cycle of latency but handles arbitrarily large prompts. The 2MB threshold is checked at serialization time; prompts under 2MB are sent inline.
- **Stream chunks:** Individual chunk batches are small (~1-10KB). Never approach the limit.

Messages exceeding 2MB are rejected at insert time with an error.

### 3.8 RELAY_WAIT (Agent Loop Integration)

When the orchestrator needs to call a remote service, it enters a sub-state within TOOL_EXECUTE (for tools) or LLM_CALL (for inference). The sub-state has two modes:

#### Request/Response Mode (tools, resources, prompts, cache-warm)

```
RELAY_WAIT (sub-state of TOOL_EXECUTE):
  Write request to relay_outbox
  Trigger immediate sync cycle (delivers outbox to hub)
  while true:
    Check relay_inbox for 'result' or 'error' with matching ref_id
    If found → extract result → return to caller
    If expired (timeout_ms exceeded) → return timeout error
    Update heartbeat_at
    Update activity status: "relaying github-create-issue via cloud-vm"
    Sleep(sync_interval / 2)
    Trigger sync cycle
```

#### Streaming Mode (inference)

```
RELAY_STREAM (sub-state of LLM_CALL):
  Generate stream_id (UUID)
  Write 'inference' request to relay_outbox (with stream_id)
  Update activity status: "connecting to cloud-vm for claude-opus-4..."
  Trigger immediate sync cycle
  Initialize: last_seq = 0, chunk_buffer = []
  while true:
    Collect all relay_inbox entries where stream_id matches, ordered by seq
    For each new chunk message (seq > last_seq):
      If seq != last_seq + 1:
        Buffer out-of-order message; do not yield yet (gap detected)
      Else:
        Yield each StreamChunk in the batch to the local streaming pipeline
        Yield any buffered messages that are now contiguous
        last_seq = highest contiguous seq yielded
      Reset silence timeout (chunks are arriving — connection is alive)
      Update activity status: "inference via cloud-vm (streaming, {n} tokens)"
    If 'stream_end' received and all seq gaps filled:
      Yield final chunks
      Return usage stats to caller → exit sub-state
    If 'error' received:
      Return error to caller → exit sub-state
    If expired (timeout_ms exceeded with no new chunks) → return timeout error
    Update heartbeat_at
    Sleep(sync_interval / 2)  — or woken by eager push delivery
    Trigger sync cycle
```

**Pre-streaming dead zone.** Between sending the inference request and receiving the first chunk, the user sees no streaming tokens. This dead zone varies from ~1 second (hub-targeted, eager push) to ~10+ seconds (NAT'd target, polling). The activity status MUST update immediately to `"connecting to {host} for {model}..."` so the user knows work is in progress. The web UI should render this as a distinct visual state (e.g., a pulsing indicator different from the "tokens arriving" animation). On first chunk arrival, the status transitions to `"inference via {host} (streaming, {n} tokens)"`.

**Stream gap resolution.** Gaps occur when eager push delivers a later chunk before sync delivers an earlier one — rare, but possible. The policy:

1. Buffer out-of-order chunks. Do not yield them yet.
2. On each poll iteration, check whether buffered chunks are now contiguous with `last_seq`. If so, yield them.
3. If a gap persists for more than 2 sync cycles without the missing chunk arriving, yield the buffered chunks anyway and advance `last_seq` past the gap. This accepts a minor discontinuity (a few missing words) rather than blocking the stream indefinitely. A `system` note is logged: `"Stream gap: seq {n} missing, {m} chunks skipped."` Tool-use streams with partial JSON may produce garbled arguments, which the sandbox reports as a parse error — the LLM adapts on the next turn.
4. If `stream_end` arrives with gaps still open, wait one additional sync cycle for gap fill, then yield everything remaining and close the stream.

The local streaming pipeline (§4.6 of the base spec) receives chunks from RELAY_STREAM exactly as it would from a local LLM backend's `AsyncIterable`. This means:

- The activity status endpoint (R-U19) updates as tokens arrive — `thinking` → `tool_call`.
- The 120-second silence timeout (R-W6) resets on every chunk batch — streaming responses never trigger it.
- The web UI displays partial responses in real-time (at the transport's flush cadence).
- The Cancel button (R-U20) works: it aborts RELAY_STREAM, and a cancellation message is relayed to the target host to abort the inference call.

#### Cancel Handling

When the user presses Cancel during RELAY_WAIT or RELAY_STREAM:

1. Stop waiting for responses.
2. For streaming: send a `cancel` kind message to the target via relay (best-effort). The target aborts the in-progress inference call. If the cancel doesn't arrive in time, the target completes the call and the orphaned response chunks expire.
3. Preserve any already-persisted tool messages.
4. Add a cancellation `system` message identifying the host.
5. Run FS_PERSIST.
6. Return to IDLE.

### 3.9 Target-Side Execution

When the target host finds unprocessed requests in its `relay_inbox`:

#### For Request/Response Kinds

1. **Validate.** Check that the requested tool/resource/prompt exists locally and the requesting host is in the keyring.
2. **Check idempotency cache.** If a response for this key is cached, return it without re-executing.
3. **Check expiry.** If `expires_at` has passed, discard. The requester has already timed out.
4. **Execute.** Resolve the tool to the local MCP server, call it, capture stdout/stderr/exit code.
5. **Write response.** Create a `relay_outbox` entry with `kind = 'result'` (or `'error'`), `ref_id` set to the request ID, `target_site_id` set to the requester.
6. **Mark inbox entry as processed.**
7. **Trigger sync if not recently synced.**

#### For Inference Requests

1. **Validate.** Check that the requested model is available locally. Check the requester is in the keyring.
2. **Check expiry.** If `expires_at` has passed, discard.
3. **Resolve prompt.** If the inference request contains a file reference instead of inline messages (§3.7 large prompt handling), read the prompt from the synced file.
4. **Start inference.** Call the local LLM backend's `chat()` method with the provided parameters. The provider driver translates to the provider's native format as usual (§4.6).
5. **Stream chunks.** As the `AsyncIterable<StreamChunk>` yields chunks, buffer them. Flush the buffer to a `stream_chunk` relay outbox entry when: (a) the flush timer fires (200ms), (b) the buffer exceeds 4KB, or (c) the stream ends.
6. **On stream completion.** Write a `stream_end` relay outbox entry with the final chunk batch and usage stats.
7. **On error.** Write an `error` relay outbox entry.
8. **On cancel received.** Abort the `AsyncIterable` (provider driver cancels the HTTP request). Write a final `error` with `"cancelled by requester"`.

#### For Cancel Messages

A `cancel` message carries `ref_id` set to the original request's `id` (matching the `ref_id` that response messages carry). For inference streams, the target matches the `ref_id` against active streams' originating request IDs to find the stream to abort. The payload is empty (`"{}"`).

Cancel messages use a short `expires_at` — the same as `stream_flush_ms × 10` (default: 2 seconds). A cancel that arrives after the operation completes is useless, so there's no value in a long TTL. If the cancel expires before delivery, the operation completes normally and the orphaned result expires on the requester side.

If the referenced request is an active inference stream, the target aborts it (step 8 above). If it's a tool call, the cancel is best-effort — MCP tool calls cannot be interrupted mid-execution. The tool either finishes before the cancel arrives (and the result is sent back normally, potentially orphaned on the requester side) or it's still in the MCP server's hands (where it will complete and the result will be discarded by the requester).

Execution is non-blocking — the orchestrator processes relay inbox entries in a background loop, not during the sync handshake. Multiple inference streams can run concurrently on the same target host.

### 3.10 Platform Connector Leadership

Platform connectors (Discord, Slack, Matrix, Telegram, etc.) are external messaging integrations configured per-host in `config/platforms.json` (replacing `config/discord.json`). For platforms where multiple clients can connect with the same credentials (Discord, Matrix), the system elects ONE host as the **connector leader** — the host actively connected to the platform. Other hosts with the same platform configured are standby.

**Leadership storage.** For each platform, the leader is stored in `cluster_config`:

| Key | Value |
|---|---|
| `platform_leader:discord` | host_name of the current leader |
| `platform_leader:slack` | host_name of the current leader |

Leadership records replicate via normal sync (LWW on `modified_at`).

**Election.** On startup, for each locally-configured platform: if no leader exists in `cluster_config`, write self as leader (LWW race — one wins). If a leader exists and it's this host, connect. If a leader exists and it's another host, enter standby and monitor the leader's sync recency.

**Failover.** The standby monitors the leader's health via the leader's `hosts.modified_at` timestamp in the replicated `hosts` table. The leader periodically updates its own `hosts.modified_at` at an interval of `failover_threshold_ms / 3` (default: every 30s for a 90s threshold). This generates a change_log event that replicates to all hosts, proving liveness. If the leader's `hosts.modified_at` is older than `failover_threshold_ms` as observed locally, the leader is presumed offline. The standby promotes itself: writes self as new leader to `cluster_config`, syncs, connects to the platform. If the old leader reconnects later, it syncs, sees the new leader, and demotes itself to standby. LWW ensures the newer write wins.

**Why `hosts.modified_at` and not `sync_state`:** `sync_state` is non-replicated — the standby can't read the leader's sync_state directly. The `hosts` table is replicated, so every host can observe every other host's last heartbeat. The periodic heartbeat write is cheap: one small LWW upsert per interval, pruned from the change_log within one sync cycle.

**Exclusive platforms (Slack webhook, Telegram webhook).** Only one endpoint receives events by protocol design. The leader is whichever host's URL is configured as the webhook target. On leader promotion, the connector calls the platform's API to update the webhook URL to the new leader's endpoint. On leader demotion, the connector stops listening. The URL rotation is part of the connector's `connect()` lifecycle — not a separate optional step.

**Manual override.** `boundctl set-platform-leader discord laptop --wait` forces leadership, same pattern as `boundctl set-hub`.

**hosts table.** Each host advertises its configured platforms in a new `platforms` column (`TEXT`, LWW, JSON array), the same pattern as `mcp_servers` and `models`.

### 3.11 Platform Intake Pipeline

When the connector leader receives a platform event (e.g., a Discord DM):

**Step 1 — Persist with deterministic UUID.** The message ID is `UUID5(namespace, "{platform}:{platform_event_id}")`. `INSERT OR IGNORE` into the messages table. If two hosts both received the event during a failover overlap, they produce the same row — the append-only reducer deduplicates.

**Crucially, persisting a platform message does NOT trigger an agent loop.** The base spec's R-E1 ("when a user sends a message... initiate an agent response loop") applies only to `interface = 'web'` messages, where the receiving host is always the processing host. For platform messages, loop initiation is decoupled from persistence — it happens in step 4 when the `process` signal arrives from the hub. This prevents the race condition in `leadership: "all"` mode where every host would otherwise start its own agent loop on persist, before the hub's intake dedup has a chance to fire.

**Step 2 — Submit intake claim.** Write an `intake` relay message to the hub:

```json
{
  "platform": "discord",
  "platform_event_id": "1234567890",
  "thread_id": "thread-uuid",
  "user_id": "user-uuid",
  "message_id": "msg-uuid"
}
```

The `idempotency_key` is `"intake:{platform}:{platform_event_id}"`.

**Step 3 — Hub dedup and routing.** The hub checks the idempotency cache. If present (another host already claimed this event during failover overlap), discard. Otherwise, select a processing host per the intake routing algorithm (§5.4). Write a `process` signal to the selected host.

**Step 4 — Processing host runs agent loop.** The processing host receives the `process` message. First, it checks for duplicate processing: if the thread already has an `assistant` message with `created_at` newer than the triggering user message, the `process` signal is stale (another host already processed the message — possible during `leadership: "all"` failover or hub migration). The processing host discards the signal silently.

Otherwise, the user message should already be present locally — the sync protocol's phase ordering guarantees that change_log events (PUSH/PULL) are exchanged BEFORE relay messages (RELAY), so the message row arrives in the same sync cycle as the `process` signal. If somehow absent (e.g., the connector host persisted the message but crashed before syncing), the processing host waits one additional sync cycle. If still absent, it writes an `error` relay response to the connector leader, which re-submits the intake claim on the next stale-thread scan (§3.11 stale thread recovery).

**Step 5 — Response delivery.** When the agent loop produces a response and the thread's `interface` is a platform (not `'web'`): if the processing host IS the current connector leader, deliver directly. Otherwise, write a `platform_deliver` relay message to the current leader:

```json
{
  "platform": "discord",
  "thread_id": "thread-uuid",
  "message_id": "response-msg-uuid",
  "content": "Here's what I found...",
  "attachments": []
}
```

The leader delivers via the platform's API. If the leader changed since routing, the processing host resolves the CURRENT leader from `cluster_config` and retries once.

**Proactive delivery (§10.8).** Autonomous task output for platform-originated threads uses the same `platform_deliver` relay mechanism. No special path.

**Stale thread recovery.** Every `5 × sync_interval`, the connector leader scans for threads where the last message is from the user with no assistant response and no active agent loop. These represent messages that were persisted but never processed (e.g., processing host crashed mid-loop). The leader re-submits an intake claim, which the hub routes to a healthy host.

### 3.12 Cross-Host Event Propagation

The base spec's `emit` defineCommand fires events on the local host only (§10.2). With the relay, `emit` gains cluster-wide propagation:

When the agent calls `emit --event "project.review_complete" --payload '{...}'`:

1. **Fire locally** (unchanged). The local scheduler immediately checks for matching event-driven tasks and claims/executes them.
2. **Broadcast via relay.** Write an `event_broadcast` relay message to the hub with `target_site_id` set to a special sentinel value (`"*"` — broadcast). The hub copies the message to ALL other spokes' relay outboxes.

```json
{
  "event_name": "project.review_complete",
  "event_payload": { "project": "acme" },
  "source_host": "cloud-vm",
  "event_depth": 1
}
```

3. **Remote hosts fire locally.** Each remote host receives the `event_broadcast` in its relay inbox and emits the event to its local scheduler. Event-driven tasks matching the event name fire on the remote host — but with a **pre-claim check**: if the matching task's `claimed_by` is already set and `claimed_at` is within `2 × sync_interval`, the remote scheduler skips the claim (another host already got it). This check uses the local DB's view of the task, which is at most one sync cycle stale. In the common case (emitting host claimed locally and synced before the broadcast arrives), the remote host sees the claim and skips. In the rare case where the broadcast arrives before the claim syncs, both hosts claim and the base spec's lease_id mechanism (§10.5) resolves the overlap — duplicate side effects are possible but tolerable, same as the base spec's existing overlapping execution semantics.

**Latency improvement.** Without relay broadcast: emit on cloud-vm → task syncs → laptop claims on next scheduler tick → ~30-60s. With relay broadcast: emit on cloud-vm → broadcast via relay → laptop fires immediately on next sync → ~5-15s (one sync cycle, not two).

**Event depth propagation.** The `event_depth` from the broadcast is injected into any tasks fired by the remote scheduler, preserving the cross-host event loop protection (§10.2).

**Single-host mode.** When sync is disabled, `emit` fires locally only (no relay outbox). Identical to the base spec behavior.

**Scope.** Only agent-emitted events (via the `emit` defineCommand) are broadcast. Lifecycle events (`sync.completed`, `host.startup`, `sync.failed`) remain host-local — they fire at high frequency or are inherently host-specific, and broadcasting them would create O(N²) relay traffic for minimal benefit. Data events (`memory.updated`, `task.created`, `file.changed`) also remain local — the underlying data changes replicate via the change_log, and remote hosts' schedulers pick up matching event-driven tasks via the normal claim mechanism.

### 3.13 Activity Status Forwarding

When message intake routes processing to a different host than the one connected to the platform (or the web UI host), the originating host's activity status endpoint (R-U19) shows `idle` — the processing is happening elsewhere. The user sees no "thinking" indicator.

**Solution:** The processing host periodically forwards its activity status to the originating host via `status_forward` relay messages. These are lightweight, high-frequency, and fire-and-forget:

```json
{
  "thread_id": "thread-uuid",
  "status": "tool_call",
  "detail": "github-create-issue",
  "tokens": 847
}
```

The originating host caches the latest forwarded status per thread in ephemeral memory and serves it from the activity status endpoint. When the processing host's loop completes, it sends a final status update of `idle`, and the originating host clears the forwarded status.

**Who is the originating host?** For web UI messages: the host running the web UI (where the user typed). For platform messages: the connector leader (which received the Discord DM / Slack message). For delegated web UI loops (§5.6): the local web UI host that delegated.

**Platform typing indicators.** When the connector leader receives a `status_forward` with `status != 'idle'`, it translates to the platform's native typing indicator (e.g., Discord's `POST /channels/{id}/typing`, Slack's `chat.postMessage` with typing flag). When status returns to `idle`, the connector stops sending typing indicators. Platform connectors that don't support typing indicators ignore status forwards silently.

**Delivery cadence.** Status forwards are sent on every status change (idle → thinking → tool_call → thinking → idle), not on a timer. Typical: 2-10 messages per agent loop. Like all relay messages, they travel through the hub — the hub eager-pushes them to the originating host if addressable, otherwise they arrive on the next sync pull. For NAT'd originating hosts without eager push, status updates may be ~5 seconds stale; this is acceptable for a "thinking" indicator. The web UI gracefully handles stale status by showing the last known state.

**Web UI interaction.** The web UI's polling of `/api/threads/{id}/status` works identically — it doesn't know the status was forwarded from another host. The "thinking" indicator, cancel button, and partial response display all work as if processing were local.

**Cancel propagation.** When the user presses Cancel on the originating host, the originating host sends a `cancel` relay message to the processing host (same mechanism as §3.8). The activity status updates to cancellation.

---

## 4. Wire Format

### 4.1 Sync Request (Spoke → Hub)

The sync request body gains a `relay_outbox` field:

```json
{
  "push": { "events": [...] },
  "pull_cursor": 4821,
  "relay_outbox": [
    {
      "id": "msg-uuid-1",
      "stream_id": null,
      "target_site_id": "d4e5f6...",
      "kind": "tool_call",
      "ref_id": null,
      "idempotency_key": "abc123",
      "payload": "{\"tool\":\"github-create-issue\",\"args\":{...}}",
      "created_at": "2026-03-24T10:00:00Z",
      "expires_at": "2026-03-24T10:01:00Z"
    }
  ]
}
```

When a spoke has no relay messages to send, `relay_outbox` is an empty array.

### 4.2 Sync Response (Hub → Spoke)

```json
{
  "events": [...],
  "relay_inbox": [
    {
      "id": "msg-uuid-2",
      "stream_id": "stream-uuid-1",
      "source_site_id": "d4e5f6...",
      "kind": "stream_chunk",
      "ref_id": "msg-uuid-inference-req",
      "payload": "{\"chunks\":[...],\"seq\":3}",
      "expires_at": "2026-03-24T10:03:00Z"
    }
  ],
  "relay_delivered": ["msg-uuid-1"],
  "relay_draining": false
}
```

`relay_delivered` lists outbox message IDs the hub accepted. The spoke marks these as `delivered = 1`.

`relay_draining` — when `true`, the spoke holds back request-kind outbox entries and does NOT mark them as delivered. Response-kind and operational signal entries are still sent and delivered normally. See §6.9 for the hub migration drain protocol.

### 4.3 Eager Push Endpoint (Hub → Addressable Spoke)

```http
POST /api/relay-deliver HTTP/1.1
X-Site-Id: <hub-site-id>
X-Timestamp: 2026-03-24T10:00:05Z
X-Signature: ...
Content-Type: application/json

{
  "messages": [
    {
      "id": "msg-uuid-3",
      "stream_id": "stream-uuid-1",
      "source_site_id": "d4e5f6...",
      "kind": "stream_chunk",
      "ref_id": "msg-uuid-inference-req",
      "payload": "{\"chunks\":[...],\"seq\":4}",
      "expires_at": "2026-03-24T10:03:00Z"
    }
  ]
}
```

Response: `200 OK` with `{"received": ["msg-uuid-3"]}`. Only the hub may call this endpoint.

---

## 5. Routing

### 5.1 Tool Routing

When the agent calls a tool not available locally:

```
1. Check local tools → not found.
2. Query hosts table: which hosts list this tool in mcp_tools?
3. If no host has it → return "tool not available" error.
4. Filter by recency: exclude hosts whose last sync activity
   is older than 2 × sync_interval (likely offline).
5. If no recent hosts remain → return "tool not reachable" error
   with the host name and staleness duration.
6. Select target host from recent hosts:
   a. Prefer the host with the most recent sync.
   b. On tie, prefer the host with fewer pending relay messages
      in the local outbox.
7. Write request to relay_outbox → enter RELAY_WAIT.
8. If RELAY_WAIT times out → try next eligible host.
   If all exhausted → return error to agent.
```

### 5.2 Inference Routing

When the model router (§4.6) needs to send an inference call and the selected model is not available locally:

```
1. Check local model_backends → model not configured here.
2. Query hosts table: which hosts list this model in hosts.models?
3. If no host has it → return "model not available" error (R-O1 suggests alternatives).
4. Filter by recency: exclude hosts whose sync_state.last_sync_at
   is older than 2 × sync_interval. These hosts are likely offline;
   waiting for them to respond would waste the user's time.
5. If no recent hosts remain → return "model not reachable" error
   with suggestion: "{model} is configured on {host}, but {host}
   hasn't synced in {duration}. Try again when {host} is online."
6. Select target host from recent hosts:
   a. Prefer the host with the most recent sync.
   b. On tie, prefer the host with fewer pending relay messages
      in the local outbox (lower local queue depth = less contention
      on that relay path).
7. Write 'inference' request to relay_outbox → enter RELAY_STREAM.
8. If RELAY_STREAM times out → try next eligible host.
   If all exhausted → return error to caller → ERROR_PERSIST (§4.5).
```

**Tiebreaker rationale (same for tool and inference routing).** The routing decision uses only locally-observable state: sync recency (from `sync_state`) and local outbox depth (from `relay_outbox`). Remote host load (active inference streams, CPU usage) is not observable without a status-reporting protocol that would add complexity. The local outbox depth is a sufficient proxy: a host with 20 pending messages is either slow to sync or overloaded, and either way routing elsewhere is better. In typical 2-3 host clusters, tiebreaking is rare — most tools and models exist on exactly one host.

Inference routing is triggered by the model router BEFORE the LLM_CALL state in the agent loop (§4.5). The model router resolves the selected model against the cluster-wide model pool. If the model is local, the normal `chat()` call happens. If remote, the orchestrator enters RELAY_STREAM instead of calling `chat()` directly. From the rest of the agent loop's perspective, the result is the same: an `AsyncIterable<StreamChunk>`.

**Staleness in the model selector.** The web UI model selector annotates remote models with sync recency. Models on hosts that haven't synced in more than 2 × sync_interval are shown as dimmed / "(offline?)" instead of "(via relay)". This is a HINT, not a hard block — the user can still select the model (the host may come back online before the request reaches it). But it sets expectations: selecting an offline model will likely time out.

```
Model selector:
  ● ollama/llama-3-70b          (local)
    bedrock/claude-opus-4        (cloud-vm, via relay)
    openai/gpt-4o               (work-desktop, offline?)
```

### 5.3 Hub as Requester

The hub is just another host running the same orchestrator code. When the hub needs to call a tool or model on a spoke, it follows the same routing logic (§5.1, §5.2) — writing to its own `relay_outbox`. The key difference: the hub doesn't need to sync to deliver the message. It stores the message in its own outbox and delivers it directly to the target spoke on the spoke's next sync cycle (step 4b of the relay phase). For addressable spokes, the hub eager-pushes immediately. The latency is halved compared to spoke-to-spoke relay (one hop instead of two).

### 5.4 Intake Routing (Platform Messages)

When a platform connector submits an `intake` claim to the hub (§3.11 step 3):

```
1. Dedup: check idempotency cache for this platform event ID.
   If duplicate → acknowledge and discard.
2. Identify the thread.
3. Select processing host (first match wins):
   a. THREAD AFFINITY: if an agent loop is currently active for
      this thread on a host (tracked via status_forward messages
      passing through the hub, stored in a hub-local
      Map<thread_id, host_name>), route there.
   b. MODEL MATCH: route to a host that has the thread's selected
      model locally (from hosts.models). Avoids inference relay.
   c. TOOL MATCH: if the thread's last 10 tool_call messages
      referenced specific MCP tools (from messages.tool_name),
      route to the host that has the majority of those tools
      locally (from hosts.mcp_tools).
   d. FALLBACK: among all hosts synced within 2 × sync_interval,
      pick the one with the fewest pending relay messages in the
      hub's outbox (same tiebreaker as §5.1/5.2).
4. Write 'process' signal to the selected host.
```

The processing host may be different from the connector leader host. The response travels back via `platform_deliver` relay (§3.11 step 5). Activity status is forwarded to the connector leader via `status_forward` (§3.13).

### 5.5 Confirm Gates

Per R-U32, confirmed tools require user approval on the **originating host** before execution. The confirm gate is checked BEFORE writing the request to the relay outbox. If the user declines, no relay message is sent.

Inference calls are not subject to confirm gates (they don't have side effects in the MCP sense — the model generates text, it doesn't modify external systems).

### 5.6 Web UI Loop Delegation

For interactive web UI conversations, the agent loop normally runs on the local host. But when the selected model AND the most-used tools are both on the same remote host, every LLM turn AND every tool call within each turn incur separate relay round-trips. A 5-tool-call conversation accumulates ~100 seconds of relay latency on top of actual computation.

**Optimization: delegate the entire agent loop to the remote host.** The orchestrator applies this when ALL of the following hold:

1. The thread's selected model is not available locally.
2. Exactly one remote host has the model (unambiguous target).
3. That host has ≥50% of the MCP tools referenced in this thread's last 10 `tool_call` messages (from `messages.tool_name`, checked against `hosts.mcp_tools`). Threads with no tool history satisfy this vacuously.

When all three hold, the orchestrator submits a `process` relay message to that host — the same intake pipeline that platform connectors use. The local host becomes the "originating host" (receives status forwards, displays partial responses, handles cancel) and the remote host becomes the "processing host."

```
Web UI loop delegation decision:
  model_host = resolve(selected_model)  → NULL if local, host_name if remote
  IF model_host is NULL → run locally (model is local)
  IF multiple hosts have model → run locally, relay inference
  IF model_host has ≥50% of thread's recent tools → delegate to model_host
  ELSE → run locally, relay inference + tool calls individually
```

If condition 2 fails (multiple hosts), the orchestrator falls back to local execution with relay. Picking among multiple candidates requires the load-aware routing that intake uses (§5.4), and interactive conversations shouldn't pay that decision cost on every turn.

Delegation is transparent to the agent. Confirmed tools (§5.5) are BLOCKED on delegated loops — the user is not present on the processing host to approve them, same as autonomous tasks. The agent sees the block error and adapts (e.g., writes a draft instead of posting directly). If a thread's workflow depends heavily on confirmed tools, delegation condition 3 (≥50% tool match) will typically fail anyway, since confirmed tools require the originating host's web UI for approval.

The fallback (run locally, relay everything) is always correct, just slower. Delegation is a pure latency optimization with no semantic difference.

---

## 6. Interaction with Base Spec Features

### 6.1 `help` Command (§7.6)

Two tiers:

```bash
$ help
LOCAL tools (this host):
  filesystem-read-file, filesystem-list-dir

REMOTE tools (via relay):
  github-create-issue (cloud-vm), github-list-pull-requests (cloud-vm), ...
  slack-post-message (cloud-vm), ...

UNAVAILABLE (hosts offline):
  (none)
```

No distinction between addressable and non-addressable hosts. Remote is remote.

### 6.2 Model Selection (§4.6, R-U11)

The model selector in the web UI presents the **cluster-wide union** of all models from all online hosts. Each model is annotated with its host and sync recency:

```
Model selector:
  ● ollama/llama-3-70b          (local)
    bedrock/claude-opus-4        (cloud-vm, via relay)
    openai/gpt-4o               (work-desktop, offline?)
```

Models on hosts that haven't synced recently are dimmed with "(offline?)" — a visual hint that selecting them will likely time out. The user can still select them (the host may reconnect), but expectations are set.

Selecting a remote model is seamless — the orchestrator routes inference through the relay. The model annotation on messages (§9.6) records both the model AND the executing host: `[assistant, claude-opus-4 via cloud-vm, 5s ago]`.

The volatile context (§9.2) includes the model's location:

```
You are: claude-opus-4 (via Bedrock on host "cloud-vm", relayed from "laptop")
```

This lets the agent know that tool calls to cloud-vm's MCP servers will be fast (colocated with the model) while tool calls to laptop's MCP servers will involve relay round-trips.

### 6.3 Model Hints (§6.4)

The `model-hint` defineCommand now routes across the cluster:

```bash
# Hint a model on a remote host — relay handles the inference
model-hint bedrock/claude-opus-4

# Hint a local model — no relay needed
model-hint ollama/llama-3-8b
```

The orchestrator validates that the hinted model exists SOMEWHERE in the cluster (not just locally). The user's explicit model selection (R-U24) overrides agent hints, same as before.

### 6.4 Task Model Routing

Tasks with `--model-hint` or `--requires model:X` now resolve against the cluster-wide model pool. A task can specify both a required MCP server AND a preferred model:

```bash
# This task needs github MCP and prefers claude-opus-4
schedule --every "1h" --requires github --model-hint bedrock/claude-opus-4 \
  --payload '{"action": "review_prs"}'
```

If cloud-vm has both GitHub MCP and Bedrock, the task runs entirely on cloud-vm (no relay needed — the inference is local). If GitHub is on cloud-vm but claude-opus-4 is on work-desktop, the task runs on cloud-vm (for tool access) and the inference call relays to work-desktop. The scheduler's `can_run_here()` checks MCP requirements; the model router handles inference routing at execution time.

### 6.5 Cache Warming (§4.3)

`cache-warm` routes through the relay like any other request/response call. Cache warming is less latency-sensitive, so relay latency is a non-issue.

### 6.6 Resource and Prompt Proxying

MCP resources (`resource` command) and prompts (`prompt` command) are proxied through the relay using the typed payloads in §3.3.

### 6.7 Cancel Button (R-U20)

Cancel during relay follows the protocol in §3.8 (Cancel Handling). The key addition for the base spec interaction: external side effects from tool calls that completed before the cancel arrived (created issues, posted messages) are permanent and not rolled back. This is the same trade-off as cancelling any in-flight tool call in the base spec.

### 6.8 Emergency Stop (§12.8)

Emergency stop halts **autonomous operations** (task scheduling, cron, events). Relay message processing is NOT halted by emergency stop — the relay transport layer continues operating so that in-flight tool calls and inference requests complete. However, `process` signals (from platform intake or web UI delegation) do NOT initiate agent loops during emergency stop. The processing host acknowledges the `process` message (marks it processed) but does not start a loop. The user message is already persisted; on `boundctl resume`, the connector leader's stale-thread recovery scan (§3.11) detects unprocessed messages and re-submits intake claims.

During emergency stop: the orchestrator continues exchanging `relay_outbox`/`relay_inbox` entries during sync. Tool call and inference relay messages for already-running loops complete normally. The scheduler loop is paused. No new agent loops start from any source (web UI, platform, task).

### 6.9 Hub Migration (§8.5)

The base spec's hub migration was nearly seamless because the hub only relayed change_log events — which are persistent, cursor-tracked, and replicated. Spokes switch to the new hub and pick up where they left off.

Relay messages are different: ephemeral, local-only, and have no cursor. If spokes switch while the old hub's outbox still has undelivered relay messages — in-flight tool results, inference stream chunks, `process` signals — those messages are stranded. The requester times out, the user waits, work is repeated.

**Solution: drain before switch.** Hub migration becomes two phases, both handled automatically by `boundctl set-hub`.

#### Migration Protocol

```
$ boundctl set-hub cloud-vm --wait

Phase 1 — DRAIN (old hub, automatic):
  1. Old hub enters DRAINING state.
  2. Old hub includes a 'draining: true' flag in step 4b of
     the RELAY phase. When a spoke sees this flag, it holds
     back REQUEST-kind outbox entries (tool_call, inference,
     intake, process, platform_deliver, event_broadcast) —
     they stay delivered = 0 in the spoke's outbox. The spoke
     still sends RESPONSE-kind entries (result, error,
     stream_chunk, stream_end) and operational signals
     (cancel, status_forward) normally — these complete or
     terminate in-flight operations rather than starting new ones.
     This lets in-flight operations complete while preventing
     new operations from entering the hub.
  3. Old hub continues delivering its OWN relay outbox to spokes
     (step 4b still runs). Active inference streams flush
     remaining chunks. Pending tool results, process signals,
     and platform_deliver messages are delivered.
  4. Old hub waits until its relay outbox is empty (all entries
     delivered = 1 or expired).
  5. Drain timeout: relay.inference_timeout_ms (default: 120s).
     If the outbox isn't empty by then, remaining messages have
     already expired from the requesters' perspective (their
     RELAY_WAIT/RELAY_STREAM timed out). Proceed anyway.

Phase 2 — SWITCH (same as base spec §8.5):
  6. Old hub writes cluster_config.cluster_hub = "cloud-vm".
     Replicates via the next sync cycle.
  7. Spokes see the new cluster_hub on their next sync pull.
     They switch their sync target to cloud-vm.
  8. Spokes' held request-kind outbox entries (accumulated
     during drain) are delivered to the new hub on their first
     sync with it. The new hub routes them normally.

Phase 3 — CONFIRM (if --wait):
  9. Block until all spokes have synced with the new hub
     (confirmed via the new hub's sync_state cursors).
```

**Operator UX:**

```
$ boundctl set-hub cloud-vm --wait
Draining relay outbox...
  5 messages pending (1 active inference stream)
  ... (stream completes, messages delivered)
  0 messages pending. Drain complete (4.2s).
Propagating hub change...
  cloud-vm     ✓ confirmed (1s)
  work-desktop ✓ confirmed (32s)
All 2 peers confirmed. Hub migration complete.
```

**What happens during drain (typically 1-10 seconds):**

Spokes see the `draining: true` flag and hold back new requests in their outboxes. Requesters' RELAY_WAIT polling continues — they see no response yet, which is normal within their timeout window. Meanwhile, responses for in-flight operations flow back through the hub normally, completing tool calls and inference streams. When spokes switch to the new hub (phase 2), their held request-kind messages are delivered and routing resumes. Total visible impact: relay calls initiated during the drain window take a few extra seconds.

**What if the old hub crashes during drain:**

The drain never completes. `boundctl set-hub` on the old hub is stuck. The operator Ctrl-C's, runs `boundctl set-hub cloud-vm` on a surviving host instead. This falls through to the base spec's "hub dies permanently" path: update `sync.json` on surviving hosts, SIGHUP to reload. Relay messages in the dead hub's outbox are lost. Requesters time out and retry through the new hub. This is the one unavoidable lossy case — a crashing hub loses ephemeral state by definition.

**Why not dual-hub overlap?** Running both hubs simultaneously during migration would avoid the drain pause but creates split-brain routing: the same tool call could be routed by both hubs to different targets, producing duplicate side effects. The serialization guarantee (one hub = one routing authority) is worth a few seconds of drain.

### 6.10 Quiescence (§9.7)

Quiescence reduces sync frequency. This increases relay latency proportionally. But the interaction is benign: quiescence activates when no user has interacted in hours. If no user is interacting, no interactive relay calls are being made. The moment a user resumes, quiescence lifts, adaptive sync kicks in, and relay latency returns to normal.

Edge case: `--no-quiescence` autonomous tasks that relay tool calls or inference during deep quiescence. These tasks run at full speed (per the toleration), but their relay messages travel at quiescence-reduced sync frequency. This is acceptable — `--no-quiescence` tasks should prefer local tools and models via `--requires`, or accept relay latency.

### 6.11 Prompt Caching Across Hosts

When inference is relayed, prompt caching (§4.6, §9.2) works differently:

- **Provider-side caching (Anthropic explicit, OpenAI prefix):** The cache lives on the provider's servers, keyed by prompt content. If laptop and cloud-vm both relay inference to the same Bedrock endpoint on work-desktop, they share the provider-side cache. Cache breakpoints from the context assembly pipeline are forwarded in the inference request and applied by the target's provider driver.
- **Local KV-cache (Ollama):** The cache lives in GPU memory on the host running the model. Only inference calls routed to the SAME host benefit. If laptop relays to cloud-vm's Ollama, the KV-cache on cloud-vm is reused across calls from any requester — the cache is keyed by prompt prefix, not by requester identity.

The context assembly pipeline's prefix stability optimization (§9.2 — stable content first, volatile content last) benefits relayed inference exactly as it benefits local inference, because the optimization acts on the prompt structure, not the transport.

---

## 7. Failure Modes

| Failure | Behavior |
|---|---|
| Hub stores request, target offline | Hub holds message. Delivered when target reconnects. Expires if target stays offline past `expires_at`. |
| Request expires before delivery | Target discards without executing. Requester times out with actionable error. |
| Duplicate delivery (lost ACK) | Idempotency dedup at hub and target for request/response. Structural dedup via `stream_id` for inference. |
| Hub crash mid-relay | Undelivered messages lost. Requester times out. Agent retries via normal error path (R-E11). |
| Target executes but response lost | Target's idempotency cache returns cached result on retry (request/response). For inference: the requester times out and retries with a new `stream_id`; the orphaned stream's chunks expire. |
| Eager push fails | Hub falls back to store-and-forward. Invisible. |
| Inference stream interrupted mid-generation | Requester receives partial chunks, then times out waiting for `stream_end`. The partial response is discarded. The agent loop enters ERROR_PERSIST (§4.5). On retry, a fresh inference call is made. |
| Inference target runs out of context | Target's provider driver throws context overflow with token count. Target sends `error` response. Requester's model router truncates context (§13.1 Stage 7) and retries on the SAME target. If truncation is insufficient (prompt still too large after removing all optional context), the error propagates to the agent loop as ERROR_PERSIST. The model router does NOT try a different host for the same model — context overflow is a prompt problem, not a host problem. |

---

## 8. Configuration

### 8.1 No New Required Config

The relay is active whenever `sync.json` exists. No new config files.

### 8.2 Optional Overrides in `sync.json`

```json
{
  "hub": "cloud-vm",
  "sync_interval_seconds": 30,
  "relay": {
    "request_timeout_ms": 30000,
    "inference_timeout_ms": 120000,
    "stream_flush_ms": 200,
    "stream_flush_bytes": 4096,
    "max_pending_per_target": 100
  }
}
```

- `relay.request_timeout_ms` — Default: `30000` (30s). Timeout for request/response relay calls.
- `relay.inference_timeout_ms` — Default: `120000` (120s). Timeout for inference relay calls. Matches the base spec's silence timeout (R-W6). Reset on every chunk batch received.
- `relay.stream_flush_ms` — Default: `200` (200ms). How often the target flushes buffered stream chunks. Lower values give smoother streaming at the cost of more relay messages.
- `relay.stream_flush_bytes` — Default: `4096` (4KB). Flush when the buffer exceeds this size, regardless of timer. Prevents unbounded buffering during fast token generation.
- `relay.max_pending_per_target` — Default: `100`. Maximum undelivered relay messages the hub holds per spoke. Prevents accumulation for dead spokes.

### 8.3 `config/platforms.json` (Replaces `config/discord.json`)

```json
{
  "connectors": [
    {
      "platform": "discord",
      "token": "${DISCORD_TOKEN}",
      "allowed_users": ["alice#1234"],
      "leadership": "auto",
      "failover_threshold_ms": 90000
    },
    {
      "platform": "slack",
      "type": "webhook",
      "signing_secret": "${SLACK_SIGNING_SECRET}",
      "bot_token": "${SLACK_BOT_TOKEN}",
      "webhook_path": "/hooks/slack",
      "leadership": "auto"
    }
  ]
}
```

- `platform` — Identifier used in routing, `cluster_config` keys, `threads.interface`, and `hosts.platforms`.
- `leadership` — `"auto"` (default): participate in automatic leader election. `"leader"`: always attempt to be leader. `"standby"`: never become leader. `"all"`: all hosts connect simultaneously, rely on intake dedup for at-most-once (zero-gap failover at cost of multiple Gateway connections).
- `allowed_users` — Platform-specific user filter. Combined with `config/allowlist.json` — the user must be in BOTH.
- `failover_threshold_ms` — Default: `3 × sync_interval × 1000`. How long a leader can be unreachable before standby promotes itself.
- Platform-specific fields (token, webhook paths, signing secrets) vary by connector.

---

## 9. Metrics

### 9.1 New Columns on `turns`

```sql
ALTER TABLE turns ADD COLUMN relay_target TEXT;          -- target host_name; NULL when service is local
ALTER TABLE turns ADD COLUMN relay_latency_ms INTEGER;   -- first-token latency for inference, total for tools; NULL when local
```

Both columns are NULL for local calls and non-NULL for relayed calls. This is the sole indicator of relay usage — no separate `relay_mode` column is needed. `WHERE relay_target IS NOT NULL` selects all relayed turns.

### 9.2 New Metrics Table

```sql
CREATE TABLE relay_cycles (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  stream_id       TEXT,                -- groups stream_chunk/stream_end rows for per-stream aggregation
  direction       TEXT NOT NULL,       -- 'sent' | 'received'
  peer            TEXT NOT NULL,       -- target or source site_id
  kind            TEXT NOT NULL,       -- any §3.2 kind: 'tool_call', 'inference', 'result', 'stream_chunk', 'cancel', etc.
  delivery_method TEXT,                -- 'sync' | 'eager_push' (hub only, NULL on spokes)
  latency_ms      INTEGER,            -- end-to-end for request/response; first-chunk for streaming
  expired         INTEGER DEFAULT 0,  -- 1 if message expired before processing
  success         INTEGER NOT NULL
) STRICT;
```

Non-synced, pruned after 30 days. Individual `stream_chunk` rows enable per-stream analysis (chunk count, total bytes, delivery cadence). For high-level summaries, aggregate by `stream_id`.

### 9.3 Agent Self-Review Queries

```bash
# Relay vs local inference latency — is relay adding significant overhead?
query "SELECT CASE WHEN relay_target IS NULL THEN 'local' ELSE 'relay' END AS mode,
         AVG(ttft_ms) AS avg_ttft, AVG(latency_ms) AS avg_total, COUNT(*) AS turns
       FROM turns WHERE ts > datetime('now', '-7 days')
       GROUP BY mode"

# Which hosts am I relaying inference to most? Should I configure the model locally?
query "SELECT relay_target, model, COUNT(*) AS calls,
         ROUND(SUM(COALESCE(cost_input,0) + COALESCE(cost_output,0) +
               COALESCE(cost_cache_write,0) + COALESCE(cost_cache_read,0)), 2) AS cost_usd
       FROM turns WHERE relay_target IS NOT NULL
       AND ts > datetime('now', '-7 days')
       GROUP BY relay_target, model ORDER BY calls DESC"

# Expired relay messages — are any hosts too slow?
query "SELECT peer, kind, SUM(expired) AS expired, COUNT(*) AS total
       FROM relay_cycles WHERE ts > datetime('now', '-7 days')
       GROUP BY peer, kind HAVING expired > 0"
```

---

## 10. Changes to Base Spec

### Deleted

| Section | Disposition |
|---|---|
| §7.5 Cross-Host Tool Proxying | **Deleted entirely.** The hub relay (this RFC) replaces all proxy functionality. |
| §7.5 Proxy Mechanics | **Deleted.** See §3.4–§3.9 of this RFC. |
| §7.5 Idempotency & Side Effects | **Deleted.** See §3.6 of this RFC. |
| §7.5 "When proxying is used vs. tasks" table | **Deleted.** The relay (§3 of this RFC) replaces the proxy mechanism. Task scheduling (§10 of the base spec) is unchanged. |
| §13.4 `/api/file-fetch` endpoint | **Deleted.** Cache warming uses the relay `cache_warm` kind (§3.2). |
| §13.4 `/api/mcp-proxy` endpoint | **Deleted.** Tool/resource/prompt proxying uses relay kinds (§3.2). |
| §10.8 "Discord host" paragraph | **Deleted.** Platform connector leadership replaces single-host pinning (§3.10). |
| §12.5 `config/discord.json` | **Deleted.** Replaced by `config/platforms.json` (§8.3). |

### Replaced

| Section | Change |
|---|---|
| §7.5 Duplicate Server Names — proxy routing | Unchanged in substance. Relay routing uses the same tool-name lookup against `hosts.mcp_tools`. The `instance` field, `boundctl config validate`, and naming conventions remain. |
| §7.5 Resource and prompt proxying | See §6.6 of this RFC. |
| R-U27 | Reword: "the orchestrator shall transparently **relay** the call to that host via the hub." Remove the idempotency parenthetical. |
| §10.8 Proactive Delivery — Discord delivery | Platform-agnostic: response delivery for platform-originated threads uses the `platform_deliver` relay mechanism (§3.11 step 5). The base spec's formatting guidance (markdown, file attachments) becomes platform-connector-specific. |

### Modified

| Section | Change |
|---|---|
| §1.2 Deployment Modes | The "Discord" column becomes "Platforms" — any configured platform connector. Multi-host mode shows "On (leader-elected host)". |
| §2.1 Host Architecture diagram | Replace "Discord Handler (optional module)" with "Platform Connectors (per platforms.json)". Add relay message flow through the Sync Module. Show MCP calls, inference calls, platform intake, and event broadcasts all route through the relay. |
| §4.5 Agent Loop — TOOL_EXECUTE | Update "The tool may be a proxied remote MCP call (§7.5)" to reference this RFC. Add RELAY_WAIT as a named sub-state alongside AWAIT_POLL, with cancel behavior per §6.7. |
| §4.5 Agent Loop — LLM_CALL | Add: "If the selected model is not available locally, the orchestrator enters RELAY_STREAM (this RFC §3.8) instead of calling `chat()` directly. The result is the same `AsyncIterable<StreamChunk>`." |
| §4.6 LLM Backend Protocol | Add: "The model router resolves the selected model against the **cluster-wide** model pool (all `hosts.models` entries for online hosts). Local models are called directly via `chat()`. Remote models are called via the hub relay, which forwards the common message format to the remote host's provider driver." |
| R-U11 | Change "available LLM backends for the current host" to "available LLM backends across the cluster." The model selector presents the union of all models from all online hosts, annotated with their host. |
| R-U19 | Activity status serves locally-observed AND forwarded remote status. When processing is relayed, the processing host forwards status updates via `status_forward` (§3.13). |
| R-U20 | Cancel propagates via relay to the processing host when processing is remote (§3.13). |
| R-E1 | Generalize "via Discord DM or web UI" to "via any configured platform connector or web UI." **Decouple persist from loop-initiation for platform messages:** persisting a platform message does NOT auto-trigger an agent loop. The loop is initiated only when the hub's `process` relay signal arrives (§3.11). Web UI messages (`interface = 'web'`) retain the existing persist-and-trigger behavior. Web UI messages delegate the agent loop to a remote host when the §5.6 delegation conditions are met (all three must hold; fallback is local execution). |
| R-E14 | Generalize Discord cancel (❌ reaction) to platform-specific cancel gestures, propagated via relay. |
| R-W1 | Generalize "non-allowlisted user interacts via Discord" to "via any platform connector." |
| §5.2 `users` | Replace `discord_id TEXT` with `platform_ids TEXT` — a JSON object mapping platform names to user IDs: `'{"discord": "123456789", "slack": "U12345"}'`. Drop the `idx_users_discord` index; add a functional index or application-level lookup. The `discord_id` column is deleted, not preserved alongside. |
| §5.3 `threads` | Generalize `interface` values from `'web' \| 'discord'` to any platform name. |
| §5.8 `hosts` | Add `platforms TEXT` column (LWW, JSON array of configured platform names). |
| §5.10 `cluster_config` | Add `platform_leader:{platform}` keys (§3.10). |
| §7.6 Per-Host Tool Availability | Simplify to two tiers: LOCAL and REMOTE. `help` output shows "(via relay)" for all remote tools. |
| §7.7 Security | Replace proxy auth language with: "Relay messages are exchanged within Ed25519-authenticated sync connections. The hub validates that `target_site_id` values correspond to keyring-listed hosts. The eager push endpoint accepts messages only from the current hub." |
| §4.3 ClusterFs — Cache warming | Replace "the MCP proxy channel" with "the relay channel." Globs exceeding the payload limit are split per-file by the target. |
| §8.3 Event Exchange Protocol | Add Phase 4 (RELAY) per §3.4 of this RFC. |
| §8.5 Hub Migration | `boundctl set-hub` gains a relay drain phase (§6.9 of this RFC). Phase 1 drains the old hub's relay outbox before phase 2 propagates the hub change. The `--wait` flag now covers both drain completion and spoke convergence. The `boundctl drain` command also waits for the relay outbox to empty before declaring safe-to-shutdown. |
| §9.2 Volatile Context | Show model location: "claude-opus-4 (via Bedrock on host cloud-vm, relayed from laptop)". Show host relay mode and platform leadership in cluster topology. |
| §9.6 Message Annotations | Annotate relayed inference with executing host: `[assistant, claude-opus-4 via cloud-vm, 5s ago]`. |
| §9.7 Metrics — `turns` table | Add `relay_target` and `relay_latency_ms` columns per §9.1. |
| §10.2 Event System — `emit` | `emit` fires locally AND broadcasts to remote hosts via `event_broadcast` relay (§3.12). Remote hosts fire matching event-driven tasks immediately on receipt. |
| §13.4 Signed HTTP Protocol | Remove `/api/mcp-proxy` and `/api/file-fetch`. Add `/api/relay-deliver` (§4.3 eager push endpoint). The endpoint list becomes: `/sync/*` (event exchange + relay phase) and `/api/relay-deliver` (eager push). |
| §5.8 `hosts` — `modified_at` semantics | Platform connector leaders update `hosts.modified_at` every `failover_threshold_ms / 3` as a liveness heartbeat. This extends the existing startup/config-reload behavior. |
| §9.7 Quiescence — detection | Change "across ALL interfaces (web UI + Discord)" to "across ALL interfaces (web UI + all platform connectors)." Any user message on any platform connector counts as user activity and resets quiescence. |
| §12.2 `allowlist.json` | Replace per-user `discord_id` field with a `platforms` object mapping platform names to user IDs: `"platforms": {"discord": "123456789", "slack": "U12345"}`. Matches the `users.platform_ids` column change. |

### Added

| Location | Addition |
|---|---|
| §5 Database | `relay_outbox` and `relay_inbox` tables (§3.1). Add to non-replicated tables list in §5.14. |
| §5.15 Database Growth | Relay table pruning: hard-delete delivered/processed entries after 5 minutes. Stream chunks are the highest-volume relay traffic but are also the shortest-lived. Negligible steady-state growth. |
| §8 Sync Protocol | `/api/relay-deliver` endpoint (§4.3). |
| §12 Config Reference | `relay` section in `sync.json` schema (§8.2). `config/platforms.json` schema (§8.3). |
| §12.1 Config File Inventory | Replace `discord.json` row with `platforms.json`. |

---

## Appendix A: Latency Analysis

### Tool Call via Polling (NAT'd target)

```
t=0.0s   Agent calls github-create-issue on laptop
t=0.0s   Orchestrator writes tool_call to relay_outbox
t=0.0s   Triggers immediate sync
t=0.5s   Sync completes: request delivered to hub, stored for cloud-vm
t=5.0s   cloud-vm syncs (adaptive 5s), receives request
t=5.2s   cloud-vm executes tool
t=7.0s   cloud-vm writes result to relay_outbox
t=7.5s   laptop syncs (RELAY_WAIT polling), receives result

Total: ~7.5s typical, ~60s worst case (30s default interval)
```

### Tool Call via Eager Push (addressable target)

```
t=0.0s   Agent calls github-create-issue on laptop
t=0.5s   Sync delivers request to hub
t=0.6s   Hub eager-pushes to cloud-vm
t=0.8s   cloud-vm executes tool
t=2.8s   cloud-vm syncs, hub receives result
t=2.9s   Hub eager-pushes result to laptop

Total: ~3s typical
```

### Inference via Polling (NAT'd target)

```
t=0.0s   User selects claude-opus-4 (on cloud-vm), sends message
t=0.5s   Sync delivers inference request to hub, stored for cloud-vm
t=5.0s   cloud-vm syncs, receives request, begins inference
t=5.3s   First tokens generated, buffered
t=5.5s   200ms flush timer → stream_chunk written to outbox
t=10.0s  laptop syncs → receives first chunk batch (5s of tokens)
         Web UI displays partial response
t=15.0s  laptop syncs → second batch
t=18.0s  cloud-vm finishes → stream_end written
t=20.0s  laptop syncs → receives final batch + stream_end

Total: ~20s, tokens visible at ~10s (first sync after first flush)
Streaming granularity: ~5s batches (one per sync interval)
```

### Inference via Eager Push (addressable target)

```
t=0.0s   User selects claude-opus-4, sends message
t=0.5s   Sync delivers inference request to hub
t=0.6s   Hub eager-pushes to cloud-vm
t=0.8s   cloud-vm begins inference
t=1.0s   First tokens, 200ms flush → hub eager-pushes chunk to laptop
t=1.2s   Web UI displays first tokens
t=1.4s   Next flush → chunk → laptop (200ms cadence continues)
...
t=8.0s   stream_end → hub → laptop

Total: ~8s, tokens visible at ~1.2s
Streaming granularity: ~200ms batches (smooth)
```
