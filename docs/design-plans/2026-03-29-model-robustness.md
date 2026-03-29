# Model Robustness Design

## Summary

This design hardens the model selection and content handling layers of the Bound agent system across two dimensions. First, content types gain two new variants — `image` and `document` — that are treated as first-class peers of text and tool calls. Attachments from platform connectors such as Discord are ingested, normalized into these typed blocks, and stored durably; context assembly can then degrade gracefully (substituting text annotations in-place) when the target backend does not support vision, without touching the persisted message. Second, the model router and resolution pipeline are extended to be capability-aware: each backend's effective capabilities are computed at startup by merging provider-level defaults with per-model config overrides, and the resolution function gains a qualification phase that rejects or re-routes requests before dispatch rather than letting them fail mid-turn.

Supporting these two main features are three tightening improvements: all four LLM drivers are updated to extract provider-specific cache token counts from their response streams and persist them to the database; tool call identifiers are guaranteed unique within a turn (synthesized where providers do not supply them, and reassigned with a warning if a duplicate slips through); and rate-limited backends (HTTP 429/529) are excluded from resolution automatically for the duration of the retry window, with structured error responses distinguishing a permanent capability gap from a transient availability problem.

## Definition of Done

1. The content type system supports `image` and `document` content blocks as first-class peers of `text` and `tool_use`
2. Model resolution has a three-phase pipeline (identify → qualify → dispatch): requests are rejected at resolution time — with actionable alternatives — when the resolved backend lacks required capabilities (vision, tool_use, etc.)
3. `model_backends.json` supports per-model `capabilities` overrides that merge with provider-level defaults
4. All four drivers extract cache-aware token usage (input / output / cache_write / cache_read, with `null` for unavailable fields); the `turns` table gains two cache token columns
5. Rate-limited backends (429/529) are temporarily excluded from resolution with automatic fallback
6. Tool call identifiers are guaranteed unique within a turn across all four drivers
7. Remote host model advertisements carry per-model capability metadata; the relay's model resolution filters by capability

## Acceptance Criteria

### model-robustness.AC1: image and document content blocks
- **AC1.1 Success:** An `image` block with `base64` source round-trips through serialization/deserialization without data loss
- **AC1.2 Success:** An `image` block with `file_ref` source serializes to a path string and deserializes back to a `file_ref` source
- **AC1.3 Success:** A `document` block carries a non-empty `text_representation` after ingestion
- **AC1.4 Failure:** A message with an `image` block dispatched to a backend with `vision: false` is rejected at resolution time (not silently stripped)
- **AC1.5 Edge:** An `image` block in conversation *history* is replaced in-place with a text annotation when assembling for a `vision: false` backend; the DB row is unchanged

### model-robustness.AC2: Three-phase model resolution
- **AC2.1 Success:** A request containing image blocks resolves to a vision-capable backend
- **AC2.2 Success:** When the primary backend lacks a required capability, resolution re-resolves to an alternative with a `reResolved: true` flag
- **AC2.3 Failure:** Resolution with `reason: "capability-mismatch"` is returned when no backend in the cluster declares the required capability; error includes `unmetCapabilities` list
- **AC2.4 Failure:** Resolution with `reason: "transient-unavailable"` is returned when capable backends exist but are all rate-limited; error includes `earliestRecovery` timestamp
- **AC2.5 Edge:** Text-only requests (no requirements) pass qualification unchanged — backward-compatible

### model-robustness.AC3: Per-model capability overrides
- **AC3.1 Success:** A backend with `provider: "ollama"` and `capabilities: { vision: true }` in config reports `vision: true` from `getEffectiveCapabilities()`
- **AC3.2 Success:** Override merges with baseline — unspecified fields retain provider default values
- **AC3.3 Success:** An operator can suppress vision on a vision-capable provider by setting `capabilities: { vision: false }`
- **AC3.4 Edge:** Missing `capabilities` field in config falls back to provider baseline (backward-compatible)

### model-robustness.AC4: Cache-aware token usage
- **AC4.1 Success:** Anthropic driver emits non-null `cache_write_tokens` and `cache_read_tokens` when provider returns those fields
- **AC4.2 Success:** Bedrock driver emits non-null cache token fields when `ConverseStream` metadata includes them
- **AC4.3 Success:** OpenAI driver emits non-null `cache_read_tokens` when `prompt_tokens_details.cached_tokens` is present
- **AC4.4 Success:** Ollama driver always emits `cache_write_tokens: null, cache_read_tokens: null`
- **AC4.5 Failure:** Non-empty response with all-zero token counts triggers char-ratio fallback and sets `estimated: true`
- **AC4.6 Success:** `turns` table gains `tokens_cache_write` and `tokens_cache_read` columns; values are persisted from the `done` chunk

### model-robustness.AC5: Rate-limit handling
- **AC5.1 Success:** A 429 response causes the backend to be excluded from resolution for the `Retry-After` window (or 60 s default)
- **AC5.2 Success:** After the rate-limit window expires, the backend re-enters the eligible pool
- **AC5.3 Success:** When the primary backend is rate-limited, resolution automatically falls back to an alternative capable backend
- **AC5.4 Failure:** When all capable backends are rate-limited, resolution returns `transient-unavailable` with `earliestRecovery` rather than blocking

### model-robustness.AC6: Tool call identity
- **AC6.1 Success:** Calling the same tool twice in a single Ollama turn produces two distinct tool-use IDs
- **AC6.2 Success:** Calling the same tool twice in a single OpenAI-compatible turn produces two distinct tool-use IDs
- **AC6.3 Success:** Anthropic and Bedrock turns propagate the provider's native IDs unchanged
- **AC6.4 Failure:** Duplicate tool-use IDs detected in a single turn are reassigned and logged as a warning before entering the context pipeline

### model-robustness.AC7: Remote capability metadata
- **AC7.1 Success:** A host's `models` advertisement includes capability metadata in the new object-array format
- **AC7.2 Success:** `findEligibleHostsByModel` with a vision requirement excludes remote hosts that advertise `vision: false`
- **AC7.3 Success:** Remote hosts advertising without capability metadata (legacy string format) remain eligible for unconstrained requests
- **AC7.4 Edge:** Legacy string-format `models` entries are parsed without error and treated as unverified (no capability metadata)
- **AC7.5 Success:** Discord attachment is normalized to an `image` ContentBlock and persisted; large attachments (≥ 1 MB) are stored as `file_ref` in the `files` table

## Glossary

- **ContentBlock**: A discriminated union type (`text | tool_use | image | document`) that represents a single unit of content within an LLM message. This design adds the `image` and `document` variants.
- **ImageSource**: A discriminated union (`base64 | file_ref`) describing how image data is carried — either inline as a base64 string, or as a reference to a row in the `files` table.
- **file_ref**: A content source variant that stores a pointer to the `files` table rather than embedding raw data inline; used for large attachments above the 1 MB threshold.
- **text_representation**: A pre-extracted plain-text rendering stored alongside a `document` block at ingestion time, so context assembly can always fall back to text without on-the-fly extraction.
- **CapabilityRequirements**: A structure derived from the current turn's input (e.g., image blocks present, tools present) that the resolution pipeline uses to qualify backends before dispatch.
- **BackendCapabilities**: The set of features a model backend declares support for (e.g., `vision`, `tool_use`). Each backend has a provider-level baseline that can be overridden per-model in config.
- **effectiveCaps**: The merged, runtime-resolved capabilities for a specific backend — provider baseline combined with any per-model `capabilities` override from `model_backends.json`.
- **ModelRouter**: The central registry in the `llm` package that tracks available backends, their effective capabilities, and current rate-limit state.
- **three-phase resolution (identify → qualify → dispatch)**: An extension of the existing two-phase `resolveModel()` pipeline. The new middle phase checks the identified backend's capabilities against the request's requirements and re-routes or errors out before any network call is made.
- **capability-mismatch**: A structured resolution error indicating no backend in the cluster declares the required capability.
- **transient-unavailable**: A structured resolution error indicating capable backends exist but are all currently rate-limited; includes an `earliestRecovery` timestamp.
- **rate-limit window**: The duration (from `Retry-After` header, or 60 s by default) during which a backend that returned HTTP 429 or 529 is excluded from resolution.
- **cache tokens (`cache_write_tokens` / `cache_read_tokens`)**: Provider-reported token counts for prompt-cache activity. Anthropic and Bedrock report both write and read; OpenAI reports read only; Ollama reports neither. `null` means the provider does not expose the field.
- **zero-usage guard / char-ratio fallback**: A defensive check that detects a non-empty response with all-zero token counts (a known provider quirk) and estimates token usage from character counts, setting `estimated: true` on the result.
- **tool call identity / tool-use ID**: A per-call unique identifier attached to each tool invocation in an LLM response. Some providers (Ollama, OpenAI streaming deltas) do not supply stable unique IDs, so the drivers synthesize them.
- **collision detection**: The agent-loop check that catches duplicate tool-use IDs within a single turn and reassigns them before they enter the context pipeline.
- **in-place content substitution**: The context-assembly technique of replacing image or document blocks in the assembled `LLMMessage[]` with text annotations, without modifying the persisted database row.
- **advisory dedup**: Suppression of repeated warning notices (e.g., "image stripped for non-vision backend") per thread and backend within a process lifetime, to avoid log noise.
- **HostModelEntry**: The new object format for `hosts.models` entries, carrying `id`, `tier`, and `capabilities` alongside the model ID. Replaces the previous plain string format (which remains accepted for backward compatibility).
- **tier**: A numeric ordering field on a backend or host model entry used to express preference among alternatives of equal capability — lower tier is preferred.
- **unverified host**: A remote host advertising its models in the legacy string format, which carries no capability metadata. Such hosts are used as a fallback only when no capability-verified match exists.
- **intake relay**: A relay message of kind `intake` that routes an inbound platform message to the host responsible for that platform.
- **IntakePayload / AttachmentPayload**: The structured payload types used to carry inbound platform messages (and their file attachments) through the relay system into the agent loop.
- **LWW (Last-Write-Wins)**: The conflict-resolution strategy used by the sync layer for most tables — the row with the latest `modified_at` timestamp wins during a merge.
- **idempotent `ALTER TABLE`**: The pattern of wrapping `ALTER TABLE ... ADD COLUMN` in a try/catch that silently ignores "column already exists" errors, used to add schema columns across migrations safely.
- **`file_ref` threshold**: The file-size cutoff (1 MB, configurable in future) above which a platform attachment is stored in the `files` table rather than inlined as base64 in the message content.
- **`ConverseStream`**: The AWS Bedrock streaming API response format from which the Bedrock driver extracts token usage and cache metrics.
- **`message_start` usage event**: The Anthropic streaming API event that carries initial token counts including cache write/read fields.

---

## Architecture

Capability-aware model resolution is introduced as a router-centric design: `ModelRouter` in the `llm` package becomes the single source of truth for backend availability, effective capabilities, and rate-limit state. The `resolveModel()` function in the `agent` package is extended from a two-phase (identify → dispatch) to a three-phase (identify → qualify → dispatch) pipeline. Context assembly gains in-place content block substitution that degrades gracefully when the target backend lacks vision support.

**Content block extension.** The `ContentBlock` union in `llm/types.ts` gains `image` and `document` variants. Both carry an `ImageSource` discriminated union (`base64` or `file_ref`). `document` blocks additionally carry a `text_representation` field — pre-extracted text produced at ingestion time — so context assembly can always fall back to text without on-the-fly extraction. All four drivers receive updated message conversion logic that handles the new variants; drivers without `vision: true` in their effective capabilities never receive image blocks (the qualification phase prevents dispatch).

**Capability management.** At `createModelRouter()` time, each driver's baseline `capabilities()` result is merged with the backend config's optional `capabilities` override object to produce an `effectiveCaps` entry in `ModelRouter`. The router also maintains an in-memory `rateLimits` map (`backendId → expiry timestamp`). When the agent-loop catches an HTTP 429 or 529 from the LLM call, it calls `router.markRateLimited(id, retryAfterMs)`. Subsequent resolution attempts within the window skip that backend via `router.isRateLimited(id)`.

**Resolution pipeline.** `resolveModel()` accepts an optional `CapabilityRequirements` argument derived from the current turn's input (image blocks present, tools present, system prompt present, cache breakpoints present). Phase 2 (qualify) checks the identified backend's effective capabilities against those requirements. On mismatch, it calls `router.listEligible(requirements)` to enumerate alternatives, prefers same-model backends (by lowest `tier`), then any capable backend. If no alternative exists, it returns a structured error distinguishing `capability-mismatch` (no backend in the cluster has the required capabilities) from `transient-unavailable` (capable backends exist but are all rate-limited, with `earliestRecovery` timestamp).

**Context assembly.** `ContextParams` gains an optional `targetCapabilities` field. During Stage 5 (ANNOTATION), image blocks in historical messages are replaced in-place with text annotations when the target backend lacks `vision: true`. Document blocks are always converted to their `text_representation`. Unresolvable `file_ref` sources produce a text placeholder in-place. All replacements are to the assembled `LLMMessage[]` only — the persisted `messages.content` column is never modified.

**Remote capability metadata.** `hosts.models` is extended from a `string[]` to `Array<{id, tier, capabilities}>`. The parser accepts both formats for backward compatibility. `findEligibleHostsByModel` filters by capability requirements when provided; hosts advertising without metadata are treated as unverified and preferred only when no verified match exists.

**Platform ingestion.** `IntakePayload.attachments` is typed to carry image/document metadata. Discord connector downloads attachments and normalizes them into `image` ContentBlocks, storing inline (base64) or as `file_ref` entries in the `files` table depending on a configurable 1 MB threshold.

---

## Existing Patterns

**`ContentBlock` union extension** follows the existing pattern in `llm/types.ts` where `text` and `tool_use` are peer discriminated variants. The new `image` and `document` variants slot in as additional members of the same union.

**Idempotent `ALTER TABLE` column addition** follows the pattern established in `packages/core/src/metrics-schema.ts` for the `relay_target` and `relay_latency_ms` columns: wrap each `ALTER TABLE ... ADD COLUMN` in a try/catch that silently ignores "column already exists" errors.

**Two-phase → three-phase resolution** extends the existing `resolveModel()` in `agent/model-resolution.ts`, which already performs identify (local lookup) → dispatch (return). The qualify phase is inserted between these two existing steps, keeping the function signature backward-compatible by making `requirements` optional.

**In-place content substitution** follows the Stage 2 (PURGE_SUBSTITUTION) pattern in `agent/context-assembly.ts`: iterate the assembled message list and replace message content in the `LLMMessage[]` without touching persisted DB rows.

**JSON column backward-compatible evolution** follows the existing pattern for `hosts.mcp_tools` (a JSON array that grew from a simple list to a structured format): the parser accepts both the old string-array format and the new object-array format, treating a string entry as a minimal object with no capability metadata.

**`model_backends.json` config extension** follows the existing additive pattern: new optional fields with defaults (`capabilities` defaults to `{}`), validated by Zod, loaded through the existing `loadConfigFile` pipeline.

---

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Content Block Type Extension

**Goal:** Introduce `image` and `document` as first-class content block types throughout the type system and config schema. No behavioral changes yet — this phase establishes the data model that subsequent phases consume.

**Components:**
- `packages/llm/src/types.ts` — add `ImageSource` union and `image` / `document` variants to `ContentBlock`; add `CapabilityRequirements` interface
- `packages/shared/src/config-schemas.ts` — add optional `capabilities: Partial<BackendCapabilities>` field to `modelBackendSchema`
- `packages/shared/src/types.ts` — add `AttachmentPayload` type for `IntakePayload.attachments`; add `HostModelEntry` object type alongside existing string for `hosts.models`

**Dependencies:** None (first phase)

**Done when:** Type-checks pass across all packages (`bun run typecheck`); existing tests continue to pass; `bun test packages/llm` and `bun test packages/shared` exit 0
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Cache-Aware Token Usage Extraction

**Goal:** All four drivers report cache-specific token counts where providers expose them. The `turns` table gains two new cache token columns. Zero-usage guard prevents silent zero-cost records.

**Components:**
- `packages/llm/src/types.ts` — extend `StreamChunk` `done` variant: `usage.cache_write_tokens: number | null`, `usage.cache_read_tokens: number | null`, `usage.estimated: boolean`
- `packages/llm/src/anthropic-driver.ts` — parse `cache_creation_input_tokens` / `cache_read_input_tokens` from `message_start` usage event; add zero-usage guard with char-ratio fallback
- `packages/llm/src/bedrock-driver.ts` — parse `cacheWriteInputTokenCount` / `cacheReadInputTokenCount` from `ConverseStream` metadata; add zero-usage guard
- `packages/llm/src/openai-driver.ts` — extract `usage.prompt_tokens_details.cached_tokens` when present in stream final event; add zero-usage guard
- `packages/llm/src/ollama-driver.ts` — emit `cache_write_tokens: null, cache_read_tokens: null` (Ollama does not report cache metrics); add zero-usage guard
- `packages/core/src/metrics-schema.ts` — add `tokens_cache_write INTEGER` and `tokens_cache_read INTEGER` columns via idempotent `ALTER TABLE`; update `TurnRecord` interface and `recordTurn()`
- `packages/agent/src/agent-loop.ts` — propagate new cache token fields from `parseResponseChunks` to `recordTurn()`

**Dependencies:** Phase 1 (type changes to `StreamChunk`)

**Done when:** Unit tests for all four drivers verify correct cache token extraction (including `null` for providers that don't expose cache metrics, and `estimated: true` for the zero-usage fallback path); `bun test packages/llm` and `bun test packages/core` exit 0; integration test verifies cache columns appear in `turns` table after a mock LLM turn
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Tool Call Identity Guarantee

**Goal:** Tool call identifiers are unique within a turn across all four drivers. The Ollama and OpenAI-compatible drivers synthesize IDs when the provider does not supply them. Collision detection in the agent-loop prevents duplicates from reaching the context pipeline.

**Components:**
- `packages/llm/src/ollama-driver.ts` — synthesize tool call IDs as `ollama-{turnTs}-{index}` in the stream parser when the provider's response lacks a unique `id` field
- `packages/llm/src/openai-driver.ts` — synthesize tool call IDs as `openai-{turnTs}-{index}` under the same condition (OpenAI streaming tool calls do carry IDs, but the delta events may repeat the same index — ensure per-call uniqueness)
- `packages/agent/src/agent-loop.ts` — add collision detection in `parseResponseChunks`: track emitted tool-use IDs within a turn; on duplicate, reassign with a logged warning (R-MR24)

**Dependencies:** Phase 1 (type system stable)

**Done when:** Unit tests verify Ollama and OpenAI drivers produce distinct IDs when the same tool is called twice in a single turn; collision detection test verifies reassignment and warning log; `bun test packages/llm` and `bun test packages/agent` exit 0
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: ModelRouter Capability Management

**Goal:** `ModelRouter` becomes the single source of truth for per-backend effective capabilities and rate-limit state. Per-model `capabilities` overrides from config are merged at construction time.

**Components:**
- `packages/llm/src/model-router.ts` — add `effectiveCaps: Map<string, BackendCapabilities>` (populated in `createModelRouter` by merging `driver.capabilities()` with config's `capabilities` override); add `rateLimits: Map<string, number>` (backendId → expiry ms); add `markRateLimited(id, retryAfterMs)`, `isRateLimited(id)`, `getEffectiveCapabilities(id)`, `listEligible(requirements: CapabilityRequirements)` methods; update `BackendInfo` to reflect effective capabilities
- `packages/llm/src/model-router.ts` (`createModelRouter`) — pass `BackendConfig.capabilities` overrides into the `effectiveCaps` merge; `ModelBackendsConfig` (already typed from shared) carries the new field from Phase 1

**Dependencies:** Phase 1 (config schema + `CapabilityRequirements` type)

**Done when:** Unit tests in `packages/llm/src/__tests__/model-router.test.ts` cover: effective caps = driver baseline when no override; effective caps merge override fields; `listEligible` excludes rate-limited backends; `listEligible` excludes backends missing a required capability; `markRateLimited` + `isRateLimited` round-trip; `bun test packages/llm` exits 0
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Three-Phase Model Resolution + Context Assembly Integration

**Goal:** `resolveModel()` gains a capability qualification phase. The agent-loop derives `CapabilityRequirements` from the current turn, handles 429/529 by marking backends rate-limited, and passes `targetCapabilities` to context assembly. Context assembly applies in-place image block replacement, document text conversion, and `file_ref` fallback.

**Components:**
- `packages/agent/src/model-resolution.ts` — extend `resolveModel()` with optional `requirements?: CapabilityRequirements`; add Phase 2 (qualify) between identify and dispatch; extend `ModelResolution` error variant with `reason: "capability-mismatch" | "transient-unavailable"`, `unmetCapabilities`, `alternatives`, `earliestRecovery`; extend `EligibleHost` with optional `capabilities` and `tier` for remote filtering
- `packages/agent/src/context-assembly.ts` — add `targetCapabilities?: BackendCapabilities` to `ContextParams`; in Stage 5 add image block in-place replacement (with per-thread+backend advisory dedup), document-to-text conversion, and `file_ref` resolution from `files` table with text-placeholder fallback
- `packages/agent/src/agent-loop.ts` — derive `CapabilityRequirements` from current turn's input blocks before calling `resolveModel`; on HTTP 429/529 call `modelRouter.markRateLimited(id, retryAfterMs)`; pass resolved backend's `effectiveCapabilities` as `targetCapabilities` to `assembleContext`
- `packages/agent/src/commands/model-hint.ts` — derive requirements from recent thread message history (check for image blocks in last N messages); pass to `resolveModel`; accept hint with logged warning when resolution infrastructure unavailable

**Dependencies:** Phases 3 and 4

**Done when:** Unit tests cover: qualify phase rejects vision-required request to non-vision backend; qualify phase finds alternative backend; `capability-mismatch` vs `transient-unavailable` error kinds; in-place image replacement produces text annotations in assembled context without modifying DB; document blocks convert to `text_representation`; `file_ref` fallback on missing file; rate-limit marking + skipping round-trip in agent-loop; `bun test packages/agent` exits 0; Bedrock compat test still passes (`packages/agent/src/__tests__/context-bedrock-compat.test.ts`)
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Remote Capability Metadata

**Goal:** `hosts.models` advertises per-model capability metadata. `findEligibleHostsByModel` filters by capabilities when requirements are provided. Legacy string-array format remains parseable.

**Components:**
- `packages/cli/src/commands/start.ts` — update model ID registration to emit `Array<HostModelEntry>` objects (using `router.listBackends()` and config tier values) instead of `string[]`
- `packages/agent/src/relay-router.ts` (`findEligibleHostsByModel`) — update parser to accept both `string` entries (legacy, no capabilities) and `HostModelEntry` objects; populate `EligibleHost.capabilities` and `EligibleHost.tier`; filter by `requirements` when provided, treating unverified hosts as fallback only

**Dependencies:** Phase 5 (`EligibleHost` extended, `CapabilityRequirements` defined)

**Done when:** Unit tests cover: legacy string-array hosts remain eligible for unconstrained requests; object-format hosts with matching capabilities are preferred; object-format hosts lacking required capability are excluded; unverified hosts selected only when no verified match exists; `bun test packages/agent` and `bun test packages/cli` exit 0
<!-- END_PHASE_6 -->

<!-- START_PHASE_7 -->
### Phase 7: Platform Ingestion Normalization

**Goal:** Platform connectors normalize attachment payloads into typed `image` ContentBlocks persisted to the `messages` table. Large attachments are stored as `file_ref` entries in the `files` table.

**Components:**
- `packages/shared/src/types.ts` — finalize `IntakePayload.attachments` type as `AttachmentPayload[]` (defined in Phase 1); update relay payload types
- `packages/platforms/src/connectors/discord.ts` — download image attachments from Discord CDN URLs; normalize to `image` ContentBlocks with `base64` source (inline) or `file_ref` source (when size ≥ 1 MB threshold, written to `files` table via `insertRow`); set `description` from Discord attachment filename/description when available
- `packages/agent/src/relay-processor.ts` — ensure `intake` relay handler preserves `ContentBlock[]` content when persisting the normalized message (already persists `message_id` content from intake payload; update to handle block array serialization)

**Dependencies:** Phase 1 (ContentBlock `image` type), Phase 5 (context assembly handles image blocks end-to-end)

**Done when:** Integration test: Discord connector receives mock attachment → normalized `image` block stored in `messages.content` → context assembly produces correct output for vision-capable backend; inline vs file_ref threshold respected; `bun test packages/platforms` exits 0; `bun test packages/agent` (relay-processor tests) exits 0
<!-- END_PHASE_7 -->

---

## Additional Considerations

**Rate-limit state is in-memory only.** `ModelRouter.rateLimits` is lost on process restart. This is intentional — rate-limit windows are short-lived (typically 60 seconds) and a restart naturally re-enters all backends as eligible. Persisting rate-limit state would add complexity for negligible benefit.

**Advisory dedup state is in-memory only.** The `Set` tracking "advisory already emitted for thread+backend" in context assembly is per-process. On restart, a single additional advisory may be emitted per thread. This is acceptable — advisories are informational.

**Cache token columns use `INTEGER` (nullable), not `REAL`.** Providers report cache tokens as integer counts, not fractions. `null` indicates the provider does not report the field (distinct from `0` which means the provider confirmed no cache activity). The `estimated` flag on `StreamChunk.done.usage` propagates to a separate column in a future metrics phase; for now, `TurnRecord` stores the raw values from the `done` chunk.

**`file_ref` threshold is operator-configurable but not yet surfaced in config schema.** Phase 7 hardcodes 1 MB as the default. A future pass can add `platforms.attachment_inline_threshold_bytes` to `platformsSchema`.

**Implementation scope note:** This design covers 7 phases. The writing-implementation-plans skill limit is 8 phases, so all phases fit within a single implementation plan.
