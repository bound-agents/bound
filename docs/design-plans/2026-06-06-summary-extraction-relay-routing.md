# Route Summary Extraction Through the Inference Relay

## Summary

Summary extraction never runs for threads whose agent loop executes on a host with no local LLM backend. At the end of every loop, extraction acquires a backend with a local-only `Map` lookup (`tryGetBackend`) and runs the summarization LLM calls in-process — there is no relay in this path. When the loop is pinned to a backendless host (one advertising no models that delegates all inference over the relay), the lookup returns null and extraction is skipped every turn, emitting `Skipping summary extraction — no local backend available`. The triggering case is client-session affinity (invariant #21): a thread with a live boundless WS session runs its loop on the host holding that connection, and if that host has no local backend, its summaries never run. The skip comment claims a hub or another node will handle it; nothing does.

This design routes extraction through the same cluster-wide model resolution the main inference loop already uses. Extraction resolves its summary model via `resolveModel`; when the model is local it runs in-process exactly as today, and when it is remote a relay-backed `LLMBackend` wraps `createRelayStream$` so `extractSummaryAndMemories` consumes it through the identical `chat()` interface. The signature of `extractSummaryAndMemories` does not change, so existing callers and tests are unaffected. Extraction stays fire-and-forget off the loop's return.

## Definition of Done

1. Summary extraction completes for threads whose loop runs on a backendless host, by delegating the summarization inference over the relay.
2. A relay-backed `LLMBackend` exists that satisfies the `chat()` interface `extractSummaryAndMemories` consumes, issuing one relay inference per call.
3. Loop-end extraction acquires its backend through `resolveModel` (cluster-wide), not `tryGetBackend` (local-only).
4. Behavior on hosts with local backends is unchanged: the summary model resolves local and extraction runs in-process, with no relay row written for summarization.
5. `extractSummaryAndMemories` signature is unchanged; existing extraction tests pass without edits.

## Acceptance Criteria

### summary-extraction-relay.AC1: Relay-backed backend
- **summary-extraction-relay.AC1.1 Success:** `createRelayBackend(...)` returns an object whose `chat(params)` issues one relay inference and yields the resulting `StreamChunk`s in order.
- **summary-extraction-relay.AC1.2 Success:** the `InferenceRequestPayload` built by `chat()` carries the logical model alias in `model`, not a provider-specific id (invariant #11).
- **summary-extraction-relay.AC1.3 Success:** `capabilities()` returns the permissive stub; extraction never reads it.
- **summary-extraction-relay.AC1.4 Edge:** with no abort signal (`aborted$ = NEVER`), a `chat()` call is bounded only by `perHostTimeoutMs`.

### summary-extraction-relay.AC2: Cluster-wide acquisition in the loop
- **summary-extraction-relay.AC2.1 Success:** on a host with local backends, the summary model resolves `kind: "local"` and extraction runs in-process — no relay row written for summarization.
- **summary-extraction-relay.AC2.2 Success:** on a backendless host with a live thread, ending a loop turn writes a relay inference request and the thread's `summary` is populated after the remote responds.
- **summary-extraction-relay.AC2.3 Success:** the skip log fires only when no model resolves anywhere; its message reads `Skipping summary extraction — model unresolvable cluster-wide` and includes `summaryModelId`.
- **summary-extraction-relay.AC2.4 Failure:** when `resolveModel` returns `kind: "error"`, `acquireSummaryBackend` returns null and extraction is skipped — never attempted against a null backend.

### summary-extraction-relay.AC3: Existing behavior preserved
- **summary-extraction-relay.AC3.1 Success:** `extractSummaryAndMemories` signature is unchanged; `summary-extraction-wiring.test.ts`, `summary-rolling-synthesis.test.ts`, `summary-throttle.test.ts`, `thread-fact-seeds-confabulation.test.ts`, and `lifecycle.test.ts` pass without edits.
- **summary-extraction-relay.AC3.2 Success:** a relay extraction that errors or times out leaves `summary_through` unadvanced; the next loop end re-attempts and succeeds (self-healing).
- **summary-extraction-relay.AC3.3 Edge:** the post-restart recovery call site (`packages/cli/src/commands/start/inference.ts`) is unchanged and remains gated on local backends.

## Glossary

- **Summary extraction**: the loop-end step (`extractSummaryAndMemories`, `packages/agent/src/summary-extraction.ts`) that summarizes a thread and extracts memories/facts, writing `threads.summary` and advancing `threads.summary_through`.
- **Backendless host**: a host advertising no models (`backends: []`) that delegates all inference over the relay. Hub-only spokes running boundless loops are the common case.
- **`tryGetBackend`**: `ModelRouter.tryGetBackend` (`packages/llm/src/model-router.ts`), a non-throwing local `Map` lookup over backends instantiated on this host. Never consults the cluster.
- **`resolveModel`**: `packages/agent/src/model-resolution.ts`, the cluster-wide resolver the main loop uses. Returns a `ModelResolution` discriminated union with `kind: "local" | "remote" | "error"`.
- **Relay-backed backend**: an `LLMBackend` implementation whose `chat()` issues a relay inference via `createRelayStream$` instead of calling a local provider, letting a local-backend caller delegate transparently.
- **Client-session affinity (invariant #21)**: a thread with a live boundless / `BoundClient` WS session runs its loop on the host holding that connection, with model-based delegation suppressed so the loop keeps its `client`-kind (`boundless_*`) tools.

## Architecture

Extraction acquires its backend through cluster-wide resolution instead of a local-only lookup. When the resolved model is remote, a relay-backed `LLMBackend` wraps `createRelayStream$` so `extractSummaryAndMemories` consumes it through the same `chat()` interface it uses today.

### Relay-backed backend

A new module `packages/agent/src/relay-backend.ts` exports a factory implementing `LLMBackend` (`packages/llm/src/types.ts`):

```typescript
export function createRelayBackend(
	deps: RelayBackendDeps,        // { db, eventBus, siteId, logger }
	hosts: EligibleHost[],
	modelId: string,
	timeoutMs: number,
): LLMBackend
```

`chat(params)` builds one `InferenceRequestPayload` per call from `params` (`messages`, `system`, `max_tokens`, `temperature`), sets `model` to the logical alias `modelId` (invariant #11 — the receiving spoke resolves it to its provider-specific id) and `timeout_ms` to `timeoutMs`, drives `createRelayStream$` (`packages/agent/src/relay-stream$.ts`) to completion with `aborted$ = NEVER` and `{ perHostTimeoutMs: timeoutMs }`, and yields the collected `StreamChunk`s. `capabilities()` returns a permissive stub (`streaming: true`, other flags false, `max_context: 0`) that extraction never reads.

`aborted$` is `NEVER` because post-loop extraction has no abort signal to honor; `perHostTimeoutMs` bounds the wait. The stream buffers fully before yielding — extraction is non-interactive and reads only `chunk.type === "text"`, so no streaming behavior is lost. The two `chat()` calls inside `extractSummaryAndMemories` (summary, then facts) each produce their own relay round-trip, identical to two local `chat()` calls.

### Backend acquisition in the loop

The loop-end block selects the summary model and acquires a backend through a new private method `acquireSummaryBackend`. Model selection prefers the router's configured default (the cheap summary model on hosts that have one) and falls back to the model the loop used this turn when no default resolves — the backendless case, where `getDefaultId()` returns `""`:

```typescript
const primarySummaryModelId = this.modelRouter.getDefaultId();
const fallbackSummaryModelId = getResolvedModelId(this.lastModelResolution, this.config.modelId ?? "");
const summaryModelId = primarySummaryModelId || fallbackSummaryModelId;
```

`acquireSummaryBackend` turns the id into a backend, local or relay, by switching on the resolution kind:

```typescript
private acquireSummaryBackend(modelId: string): LLMBackend | null {
	const resolution = resolveModel(modelId, this.modelRouter, this.ctx.db, this.ctx.siteId);
	switch (resolution.kind) {
		case "local":
			return resolution.backend;
		case "remote":
			return createRelayBackend(
				{ db: this.ctx.db, eventBus: this.ctx.eventBus, siteId: this.ctx.siteId, logger: this.ctx.logger },
				resolution.hosts,
				resolution.modelId,
				this.inferenceTimeoutMs,
			);
		case "error":
			return null;
	}
}
```

A non-null backend feeds the existing fire-and-forget `extractSummaryAndMemories(...).catch(...)` call unchanged. A null backend keeps the existing skip, with the log message changed to `Skipping summary extraction — model unresolvable cluster-wide` and `summaryModelId` added to the fields. On a host with local backends, `getDefaultId()` returns a registered model, `resolveModel` returns `kind: "local"`, and extraction runs in-process exactly as before; the only new path is `kind: "remote"`.

## Existing Patterns

**Cluster-wide resolution + relay stream** — the main inference loop already calls `resolveModel(...)` and, on `kind: "remote"`, builds an `InferenceRequestPayload` and streams the response over the relay via `createRelayStream$` (`packages/agent/src/agent-loop.ts`). This design applies the same two-step (resolve, then relay-stream when remote) to the extraction backend rather than the turn's main inference.

**Fire-and-forget extraction** — loop-end extraction is already a floating `extractSummaryAndMemories(...).catch(...)` off the loop's return. The relay-backed path keeps this shape; only backend acquisition changes.

**`ModelResolution` discriminated union** — `resolveModel` returns `kind: "local" | "remote" | "error"`, consumed elsewhere by switching on `kind`. `acquireSummaryBackend` follows the same exhaustive switch.

**Boundary-aware extraction throttle** — `extractSummaryAndMemories` already limits work to once per user turn (not per inner tool round) via the throttle in `packages/agent/src/summary-extraction.ts`. The relay path inherits this unchanged, which bounds delegated summary cost.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Relay-backed backend

**Goal:** A relay-backed `LLMBackend` exists that `extractSummaryAndMemories` can consume transparently.

**Components:**
- `packages/agent/src/relay-backend.ts` — new file. Exports `RelayBackendDeps` (`{ db, eventBus, siteId, logger }`) and the `createRelayBackend` factory from the Architecture section. Import `InferenceRequestPayload`, `ChatParams`, `LLMBackend`, `StreamChunk` from `@bound/llm`; `EligibleHost` from `./relay-router`; `createRelayStream$` from `./relay-stream$`.

**Dependencies:** None (first phase).

**Done when:** `tsc -p packages/agent --noEmit` is clean and the factory compiles against the real `createRelayStream$` signature.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Unit-test the relay backend

**Goal:** The relay-backed backend's `chat()` and `capabilities()` are verified in isolation.

**Components:**
- `packages/agent/src/__tests__/relay-backend.test.ts` — new file. Construct `createRelayBackend` against an in-memory DB, seed a `relay_inbox` stream response for the expected `stream_id` the way `packages/agent/src/__tests__/relay-stream.integration.test.ts` does, and assert `chat({ system, messages, max_tokens })` yields the seeded `StreamChunk`s in order. Assert `capabilities()` returns the stub. Assert the `relay_outbox` row's payload carries `model` equal to the factory's `modelId` (logical alias, not provider id).

**Dependencies:** Phase 1.

**Done when:** `bun test packages/agent/src/__tests__/relay-backend.test.ts` passes.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Route loop extraction through resolution

**Goal:** Loop-end extraction acquires its backend cluster-wide and delegates when remote.

**Components:**
- `packages/agent/src/agent-loop.ts` — add `import { createRelayBackend } from "./relay-backend";`. Confirm `resolveModel` and `getResolvedModelId` are in scope (both already imported from `./model-resolution`); add `resolveModel` to that import if absent. Add the `acquireSummaryBackend` private method from the Architecture section to the `AgentLoop` class. Replace the loop-end backend acquisition: compute `summaryModelId` from `getDefaultId()` with the `getResolvedModelId(this.lastModelResolution, this.config.modelId ?? "")` fallback, call `acquireSummaryBackend`, and keep the existing fire-and-forget `extractSummaryAndMemories(...).catch(...)` with the resolved backend in place of `extractionBackend`. Change the skip log to `Skipping summary extraction — model unresolvable cluster-wide` and add `summaryModelId` to the fields.

**Dependencies:** Phase 1.

**Done when:** `tsc -p packages/agent --noEmit` is clean and `bun test packages/agent/src/__tests__/lifecycle.test.ts packages/agent/src/__tests__/summary-extraction-wiring.test.ts` passes unchanged (the signature did not change).
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Integration test for backendless delegation

**Goal:** End-to-end proof that a backendless host's thread gets summarized over the relay.

**Components:**
- `packages/agent/src/__tests__/summary-extraction-relay.integration.test.ts` — new file. Build a two-DB relay harness modeled on `relay-stream.integration.test.ts`: a spoke DB with an empty model router and a remote `RelayProcessor` backed by a mock `LLMBackend` returning fixed summary text. Seed a thread on the spoke with one user and one assistant message and `summary IS NULL`. Register the remote model in the spoke's `hosts` table, call `resolveModel(...)`, assert `kind === "remote"`, build `createRelayBackend(...)`, pass it to `extractSummaryAndMemories(db, threadId, backend, spokeSiteId)`, and drive the remote processor to completion. Assert `threads.summary` is non-null and equals the mock text, and that `summary_through` advanced.

**Dependencies:** Phases 1–3.

**Done when:** `bun test packages/agent/src/__tests__/summary-extraction-relay.integration.test.ts` passes.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Full gate

**Goal:** The change is green across the repo gates.

**Components:** none (verification only). Run `bun run typecheck`, `bun test packages/agent`, and `bun run lint`.

**Dependencies:** Phases 1–4.

**Done when:** all three are clean.
<!-- END_PHASE_5 -->

## Additional Considerations

**Summary cost on backendless hosts.** With no cheaper model registered locally, a backendless host's summary uses the thread's own model (e.g. an opus-tier model) rather than a cheap summary default, so delegated summaries cost more per call than local ones. The boundary-aware throttle in `extractSummaryAndMemories` bounds this to once per user turn, not per inner tool round, so the cost is proportional to user turns rather than tool activity. If a cheaper cluster-wide summary default is wanted later, it belongs in the model-selection step that computes `summaryModelId`, not in the relay backend.

**Self-healing on dropped delegation.** `summary_through` advances only on a successful write, so a relay round-trip lost to a process restart or timeout is re-attempted in full at the next loop end. This is the recovery property the local fire-and-forget already relies on, with a wider window — no durable queue is needed.

**Turn accounting.** Like the current local path, extraction does not record a `turns` row, so delegated summary cost is not stamped into turn accounting. This is unchanged behavior, not a regression introduced here.

**Post-restart recovery call site.** A second extraction call site (`packages/cli/src/commands/start/inference.ts`) runs at startup, gated on local backends, before the relay processor is initialized. It cannot use the relay and is left unchanged; its front-running role for idle threads is subsumed by the live-path fix, since any thread that takes another turn is summarized at loop end.
