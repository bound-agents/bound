# RFC: Unified Delegation — One Path, No Host-Affinity Requirements

**Supersedes (in part):** the `process`-delegation facets of 2026-04-16-client-tool-protocol.md and 2026-04-15-ws-sync-transport.md
**Supplements:** 2026-06-02-spoke-relay-trust.md, 2026-05-22-volatile-context.md
**Date:** 2026-06-29
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Motivation

A new web thread's first user message was whole-loop-delegated to the hub via the `process` relay kind. The hub re-assembled the thread's context from its own replica — but that replica had not yet received the spoke's changelog push carrying the user's first message. Stage 1 (MESSAGE_RETRIEVAL) of context assembly therefore returned an empty history, and the model was called with no user message at all.

This is observable: on thread `bcba0275-…`, turn 1's `turns.context_debug` shows `history: 0`; a later turn on the same thread shows `135` once sync caught up. The agent's first response on a fresh web thread was generated against an empty prompt.

### 1.2 The Structural Disease

The `history: 0` incident is a symptom of a deeper structural fault: **the cluster has TWO delegation paths with different correctness properties.**

- **The inference path.** The producer (the host that received the trigger and owns authoritative state) assembles the context locally, then ships the assembled result to the consumer. The consumer never re-assembles. This path is correct because assembly happens where the data is.

- **The process path.** The producer delegates the *whole loop* to a consumer, shipping only a `thread_id` + `message_id`. The consumer re-assembles context from *its own* replica. This path is incorrect whenever the consumer's replica has not yet converged — exactly the reported bug.

Patching the symptom (e.g. waiting for sync before delegating) would leave the *class* of bug intact: any consumer-side re-assembly is a race against sync convergence. The spoke-relay-trust RFC already recorded this as an accepted gap (§6.7: "Kinds that delegate a full agent loop on the target … read thread history from the target's local database, and therefore depend on change-log sync having converged that thread to the target"). This RFC closes that gap by removing the path.

### 1.3 Affinity Requirement vs. Affinity Optimization

A second, related fault: several "this host MUST run this" *requirements* are scattered across the codebase.

- Client tools have no relay kind. The loop is forced onto the WS-session host because client-tool execution can only happen where the WS client is connected (`getClientSessionDelegationTarget`, invariant #21).
- Platform intake routes to the host holding the connector (invariant #15).

These began as performance optimizations (run where the data/connection is, save round-trips) but hardened into correctness *preconditions*. A precondition is a single point of failure: if the required host is down or out of sync, the work cannot proceed at all.

The design tension this RFC resolves: **affinity should be an optimization the system MAY choose to save round-trips, never a requirement the system MUST satisfy for correctness.** Any host should be able to run any loop and serve any tool via relay; choosing to run it on the affine host is a latency win, not a correctness gate.

### 1.4 Scope Boundaries

This RFC does not remove affinity as an optimization. The producer may still prefer to assemble and run where the data is. It removes affinity as a *requirement*: when the affine host is unreachable, the work proceeds elsewhere via relay rather than failing.

This RFC does not change model resolution or target selection. It changes (a) what travels on the wire for delegation, (b) where assembly is allowed to happen, and (c) whether a tool kind can be relayed.

This RFC does not establish direct spoke-to-spoke connections (cf. spoke-relay-trust §1.4); relay remains hub-mediated.

## 2. Proposal

### 2.1 Summary

Collapse to **ONE delegation path**: the PRODUCER assembles the context and ships the assembled result; **NO consumer ever re-assembles.** Consumer-side re-assembly is removed structurally — the relay inference consumer has no access to an assembly authority and cannot import `assembleContext`.

Context on the wire becomes a list of **segments**: inline segments (the new tail) plus exactly **ONE range-pointer** covering all prior, confirmed-synced history. Because history is an append-only prefix, there is always exactly one range. The range resolves on the consumer to byte-identical messages using the same Stage-1 projection finders and annotation the producer used.

`assembleContext()` takes an explicit **`AssemblyContext`** (clock + target capabilities + host identity). Wall-clock and environment access become impossible-by-construction — assembly is a pure function of `(DB state, AssemblyContext)`, enforced by type, mirroring the R-VC25 stable-prefix purity invariant but extended to the *varying* Live State half.

**Every tool kind** (MCP, platform, client) dispatches through ONE registry path tagged `{kind: local | relay}`. The in-process client-tool deferral and the relay path become the same path with two transports. No kind is execute-here-or-fail.

### 2.2 What This Changes

| Target | Change |
|---|---|
| `process` relay kind | **Removed.** Whole-loop delegation no longer exists. Delegation is always producer-assembles + inference-relay. |
| `messages_file_ref` payload field | **Removed.** The >2MB files-table offload race is deleted; a single range-pointer is kilobytes regardless of token count. |
| Inference relay payload | Carries `segments: ContextSegment[]` instead of `messages`. |
| `assembleContext()` | Takes an `AssemblyContext`; "now" enters only via `AssemblyClock`. Output is a pure function of declared inputs. |
| `sync_state` | Adds `last_confirmed` cursor, advanced ONLY on changelog ack. It is the sole anchor authority for range-pointers. |
| Tool dispatch | All kinds route through one `{local | relay}` decision. New `client_tool` / `client_result` relay kinds. |
| `enqueueToolResult` | Made idempotent on `(thread_id, call_id)`. |
| Platform discovery | `discoverRemoteTools()` triggered eagerly at the delegation boundary and on `connector:handle_synced`. |

### 2.3 Behavioral Overview

Before: a fresh web thread's first message could be whole-loop-delegated to a host whose replica had not converged, producing an empty-history model call. After: the producer assembles locally (where the data provably exists), ships segments, and the consumer resolves the range only over rows it has *confirmed* receiving — never against an un-synced replica. The original bug class becomes unrepresentable.

A client tool referenced by a loop running on a non-session host now relays to the session host and returns its result, rather than forcing the entire loop onto the session host. If the session host drops mid-call, the caller sees a `retriable` timeout; re-driving the result is a no-op because enqueue is idempotent.

## 3. Requirements (EARS Format)

### 3.1 Ubiquitous

**R-UD1.** The system shall delegate work by a single mechanism: the producer assembles the context and ships the assembled result; no consumer shall re-assemble context from its own replica.

**R-UD2.** The system shall make consumer-side context re-assembly unrepresentable: the relay inference consumer shall resolve `segments` via a resolver that has no access to an assembly authority and shall not import `assembleContext`.

**R-UD3.** The system shall represent delegated context on the wire as a list of `ContextSegment` values: zero or more `inline` segments plus exactly one `range` segment covering the confirmed-synced history prefix (or zero range segments when nothing is confirmed-synced).

**R-UD4.** The output of `assembleContext()` shall be a pure function of its declared inputs `(DB state, AssemblyContext)`. "Now" shall enter only via `AssemblyContext.clock` (`AssemblyClock`); no wall-clock or environment read shall influence byte output.

**R-UD5.** Every tool kind (MCP, platform, client, builtin, sandbox) shall be dispatchable through one path that decides `{local | relay}` uniformly. No tool kind shall be execute-here-or-fail.

### 3.2 Event-Driven

**R-UD6.** When the producer assembles context for delegation, it shall point the single range segment only at rows whose latest `change_log` HLC is ≤ the consumer's confirmed-sync watermark; every newer row (including edits to old rows) shall travel inline.

**R-UD7.** When a peer acknowledges a changelog push (`changelog_ack`), the system shall advance that peer's `last_confirmed` cursor to the acknowledged HLC, and shall not advance `last_confirmed` on the optimistic send-side write.

**R-UD8.** When a tool call's serving host differs from the host running the loop, the system shall relay the call to the serving host and return the result to the loop, regardless of tool kind.

**R-UD9.** When a relayed tool result is re-driven (held, duplicated, or retried), `enqueueToolResult` shall be a no-op for an already-enqueued `(thread_id, call_id)`, so no double-execution or duplicate tool-result row occurs.

### 3.3 State-Driven

**R-UD10.** While resolving a range segment, the consumer shall resolve it to byte-identical messages using the same Stage-1 projection finders and annotation the producer used. A row the range points at that is missing on the consumer shall be a hard error (which R-UD6 makes unreachable by construction).

**R-UD11.** While deciding a range anchor, the system shall use `getConfirmedSyncWatermark(db, peer)` as the sole input; no other cursor (`last_sent`, `last_received`) shall decide a range anchor.

### 3.4 Optional / Deferred

**R-UD12.** Affinity (running a loop or serving a tool on the host that owns the data/connection) is an optimization the system MAY apply to save round-trips. The system shall not require affinity for correctness; when the affine host is unreachable, the work proceeds elsewhere via relay.

### 3.5 Unwanted Behavior

**R-UD13.** The system shall not delegate a whole loop to a consumer that re-assembles from its own replica (the `process` path); that path shall not exist.

**R-UD14.** The system shall not write a relay payload (assembled context or any part of it) to the synced `files` table.

**R-UD15.** The system shall not call the model with an empty history when a user message exists for the thread; the producer's inline tail shall always carry the triggering message.

**R-UD16.** When the serialized inference request exceeds `relay.max_payload_bytes`, the producer shall split it into independently relay-safe `inference_part` envelopes. The consumer shall invoke inference only after byte-identical reassembly of every part; part order and duplicate delivery shall not affect the result or cause duplicate invocation.

## 4. Data Model Changes

### 4.1 `ContextSegment` (new, `@bound/shared`)

```ts
type ContextSegment =
  | { kind: "inline"; message: LLMMessage }
  | { kind: "range"; thread_id: string; anchor_message_id: string; before: number | "all" };
```

The inference relay payload carries `segments: ContextSegment[]` in place of `messages`. The `messages_file_ref` field is removed from the payload type, so the offload code has nowhere to write its ref (a compile-time certainty).

### 4.2 New relay kinds (`RELAY_KIND_REGISTRY`)

- `client_tool` — request kind (`dispatch: "async"`), payload mirrors `ToolCallPayload` plus the session-routing key; resolves the serving host from the synced `client_sessions` table.
- `client_result` — response kind (`dispatch: "response"`), payload mirrors `ResultPayload`/`ErrorPayload`.
- `inference_part` — async request kind carrying one base64 transport part of an oversized serialized `InferenceRequestPayload`; all parts share a request ID and response stream ID.

The `process` kind is removed from the registry. Because `RelayKind` is `keyof typeof RELAY_KIND_REGISTRY`, every dead `process` reference becomes a type error.

### 4.3 `sync_state.last_confirmed` (new column)

```sql
last_confirmed TEXT NOT NULL DEFAULT '<HLC_ZERO>'
```

The three-cursor model:

- **`last_sent`** — optimistic: highest HLC we have *pushed* to this peer (advanced on send AND on ack today; remains the send/catch-up cursor).
- **`last_received`** — highest HLC we have *received and applied* from this peer.
- **`last_confirmed`** — highest HLC this peer has *acknowledged receiving* from us. Advanced ONLY in `handleChangelogAck`. This is the sole authority for range anchors: a range may cover a row only if that row's HLC ≤ the consumer's `last_confirmed`.

`getConfirmedSyncWatermark(db, peer)` reads `last_confirmed` for the peer, defaulting to `HLC_ZERO`. Cold start (peer never acked) ⇒ watermark `HLC_ZERO` ⇒ all segments inline ⇒ safe.

## 5. Edge Cases

- **Cold start (consumer never synced thread).** Confirmed watermark `HLC_ZERO` → all inline. Safe.
- **Edited old message.** Latest `change_log` HLC > watermark → inline; the synced prefix ends before the hole.
- **Prompt cache.** The single range resolves to a stable prefix turn-over-turn; the inline tail folds into next turn's range once confirmed-synced, without moving the cache breakpoint byte position.
- **Client tool, session migrates hosts mid-thread.** Each call re-resolves the session host from `client_sessions`.
- **Session drops mid-call.** Caller sees `retriable` timeout; the result (if it landed) is idempotent on re-drive (R-UD9).

## 6. Acceptance Criteria

The EARS requirements map one-for-one onto the implementation gates (Tier 1 type-impossibility, Tier 2 property tests, Tier 3 deterministic integration):

- R-UD1/R-UD13 → `process` / `messages_file_ref` removed from the union (type error on any dead reference). (AC.1)
- R-UD2 → relay consumer has no `AssemblyAuthority`; resolves via `resolveSegments`. (AC.2)
- R-UD4 → two-run determinism property test under a frozen clock, incl. cross-year and Live State. (AC.3)
- R-UD3/R-UD6/R-UD10/R-UD11 → segment round-trip + segmentation-prefix property tests. (AC.4)
- R-UD7 → ack-timing integration test: `last_confirmed` advances only on ack. (AC.5)
- R-UD15 → reported-bug regression: held changelog push, delegated first message inline, history non-empty. (AC.6)
- R-UD5/R-UD8 → client-tool relay round-trip; R-UD12 → session-kill yields `retriable`. (AC.7a/AC.7b)
- R-UD9 → re-drive idempotency unit + integration tests. (AC.7c)
- R-UD14 → audit script asserting no relay payload path writes `files`. (AC.8)
- R-UD16 → multipart codec properties (UTF-8 round-trip, frame ceiling, reorder/duplicate invariance, incomplete-set non-execution, conflicting-duplicate rejection) plus sender/receiver integration. (AC.9)
- Prompt-cache stability across segmentation. (AC.10)
