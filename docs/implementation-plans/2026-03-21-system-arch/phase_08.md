# Bound System Architecture - Phase 8: Additional LLM Drivers & Advanced Features

**Goal:** Full multi-provider LLM support (Anthropic, Bedrock, OpenAI-compatible) and remaining spec features: advisories system, message redaction, thread title generation, overlay index scanning, and cross-thread activity digest.

**Architecture:** Extend `@bound/llm` with three new drivers. Extend `@bound/agent` with advisory lifecycle, redaction cascade, title generation, and summary extraction. Extend `@bound/sandbox` with overlay index scanning. Extend `@bound/web` with advisory view and redaction UI.

**Tech Stack:** Anthropic Messages API, AWS Bedrock Converse API, OpenAI Chat Completions API, bun:sqlite (advisory table), Svelte 5 (new views)

**Scope:** 8 phases from original design (phase 8 of 8)

**Codebase verified:** 2026-03-22 — All previous phases provide the complete infrastructure. This phase adds drivers and features on top.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### system-arch.AC4: Testing strategy covers all packages with multi-instance sync validation
- **system-arch.AC4.1 Success:** Every package has unit tests that run via `bun test`
- **system-arch.AC4.7 Success:** Tests that depend on external services (real LLM, real Discord) are skippable via environment flag without breaking the test suite

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Anthropic LLM driver

**Verifies:** system-arch.AC4.7

**Files:**
- Create: `packages/llm/src/anthropic-driver.ts`
- Modify: `packages/llm/src/model-router.ts` — register anthropic provider
- Modify: `packages/llm/src/index.ts` — add exports

**Implementation:**

`packages/llm/src/anthropic-driver.ts` — Anthropic Messages API driver:

- `AnthropicDriver` class implementing `LLMBackend`:
  - Constructor: `{ apiKey: string; model: string; contextWindow: number }`
  - `chat()`: POST to `https://api.anthropic.com/v1/messages` with `stream: true`
  - Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`
  - Message translation: common format → Anthropic format (separate `system` parameter, `content` as array of content blocks, tool_use with `type: "tool_use"`, tool_result with `type: "tool_result"` and `tool_use_id`)
  - Stream parsing: SSE (Server-Sent Events) format. Parse event types: `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`. Translate to StreamChunk sequence.
  - Prompt caching: add `cache_control: { type: "ephemeral" }` to messages at `cache_breakpoints` indices.
  - `capabilities()`: `{ streaming: true, tool_use: true, system_prompt: true, prompt_caching: true, vision: true, max_context: contextWindow }`
  - Error handling: retry on 429/529 with Retry-After header, typed errors for auth failures

Update `model-router.ts` to handle `provider: "anthropic"` by creating AnthropicDriver.

**Testing:**
- Message translation: verify common → Anthropic format conversion for all message types
- SSE stream parsing: mock SSE response, parse, verify correct StreamChunk sequence
- Cache breakpoints: verify cache_control added at correct message indices
- Tests skippable via `SKIP_ANTHROPIC=1`

Test file: `packages/llm/src/__tests__/anthropic-driver.test.ts` (unit — mock HTTP)

**Verification:**
Run: `bun test packages/llm/`
Expected: All tests pass

**Commit:** `feat(llm): add Anthropic Messages API driver with prompt caching`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Bedrock and OpenAI-compatible LLM drivers

**Verifies:** system-arch.AC4.7

**Files:**
- Create: `packages/llm/src/bedrock-driver.ts`
- Create: `packages/llm/src/openai-driver.ts`
- Modify: `packages/llm/src/model-router.ts` — register bedrock and openai-compatible providers

**Implementation:**

`packages/llm/src/bedrock-driver.ts` — AWS Bedrock Converse API driver:

- `BedrockDriver` class implementing `LLMBackend`:
  - Constructor: `{ region: string; model: string; contextWindow: number }`
  - Uses AWS SDK v3 `@aws-sdk/client-bedrock-runtime` for `ConverseStreamCommand`
  - Auth: AWS credentials from environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN) or instance role
  - Message translation: common format → Bedrock Converse format
  - Stream parsing: Bedrock's event stream format → StreamChunk
  - `capabilities()`: `{ streaming: true, tool_use: true, system_prompt: true, prompt_caching: false, vision: true, max_context: contextWindow }`

`packages/llm/src/openai-driver.ts` — OpenAI-compatible API driver:

- `OpenAICompatibleDriver` class implementing `LLMBackend`:
  - Constructor: `{ baseUrl: string; apiKey: string; model: string; contextWindow: number }`
  - POST to `${baseUrl}/chat/completions` with `stream: true`
  - Headers: `Authorization: Bearer ${apiKey}`
  - Message translation: common format → OpenAI format (tool_call → assistant with tool_calls, tool_result → role "tool" with tool_call_id)
  - Stream parsing: SSE format with `data: {json}` lines. Parse delta.content, delta.tool_calls.
  - `capabilities()`: `{ streaming: true, tool_use: true, system_prompt: true, prompt_caching: false, vision: false, max_context: contextWindow }`
  - Works with: DeepSeek, Together, vLLM, any OpenAI-compatible endpoint

Update `model-router.ts` to handle `provider: "bedrock"` and `provider: "openai-compatible"`.

Add `@aws-sdk/client-bedrock-runtime` as an optional dependency in packages/llm/package.json.

**Testing:**
- Message translation tests for both drivers (common → provider format and back)
- Stream parsing with mock responses
- Bedrock tests skippable via `SKIP_BEDROCK=1`
- OpenAI-compatible tests use mock HTTP server (no skip needed)

Test file: `packages/llm/src/__tests__/bedrock-driver.test.ts` (unit — mock)
Test file: `packages/llm/src/__tests__/openai-driver.test.ts` (unit — mock HTTP)

**Verification:**
Run: `bun test packages/llm/`
Expected: All tests pass

**Commit:** `feat(llm): add Bedrock and OpenAI-compatible LLM drivers`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-5) -->
<!-- START_TASK_3 -->
### Task 3: Advisories system

**Files:**
- Create: `packages/agent/src/advisories.ts`
- Create: `packages/web/src/server/routes/advisories.ts`
- Create: `packages/web/src/client/views/Advisories.svelte`
- Modify: `packages/web/src/server/routes/index.ts` — mount advisories routes
- Modify: `packages/web/src/client/App.svelte` — add advisory route

**Implementation:**

`packages/agent/src/advisories.ts` — Advisory lifecycle per spec §9.7:

- `createAdvisory(db: Database, advisory: Omit<Advisory, "id" | "proposed_at" | "modified_at">, siteId: string): string` — Create new advisory with random UUID, status="proposed".
- `approveAdvisory(db: Database, advisoryId: string, siteId: string): Result<void, Error>` — Set status="approved", resolved_at=now.
- `dismissAdvisory(db: Database, advisoryId: string, siteId: string): Result<void, Error>` — Set status="dismissed", resolved_at=now.
- `deferAdvisory(db: Database, advisoryId: string, deferUntil: string, siteId: string): Result<void, Error>` — Set status="deferred", defer_until.
- `applyAdvisory(db: Database, advisoryId: string, siteId: string): Result<void, Error>` — Set status="applied", resolved_at=now.
- `getPendingAdvisories(db: Database): Advisory[]` — Query where status IN ('proposed', 'deferred' with defer_until past).

API routes (`/api/advisories`):
- `GET /api/advisories` — List advisories filtered by status query param
- `POST /api/advisories/:id/approve` — Approve an advisory
- `POST /api/advisories/:id/dismiss` — Dismiss an advisory
- `POST /api/advisories/:id/defer` — Defer with body `{ defer_until }`

Svelte view (`/#/advisories`): Advisory board styled as transit service-status cards per spec §11. Each card shows type icon, title, detail, impact, evidence, and action buttons (Approve/Dismiss/Defer).

**Testing:**
- Create advisory, verify it appears in pending list
- Approve advisory, verify status changes to approved with resolved_at set
- Defer advisory, verify it disappears from pending until defer_until passes
- API route tests for all endpoints

Test file: `packages/agent/src/__tests__/advisories.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/agent/ && bun test packages/web/`
Expected: All tests pass

**Commit:** `feat(agent,web): add advisories system with lifecycle management and UI`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Message redaction and thread title generation

**Files:**
- Create: `packages/agent/src/redaction.ts`
- Create: `packages/agent/src/title-generation.ts`
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

`packages/agent/src/redaction.ts` — Message redaction cascade per spec:

- `redactMessage(db: Database, messageId: string, siteId: string): Result<void, Error>` — Set message content to `"[redacted]"`, set modified_at to now. This enables LWW replication of the redaction. Also tombstone any semantic_memory entries whose `source` matches the message's thread_id (memory tombstoning).

- `redactThread(db: Database, threadId: string, siteId: string): Result<RedactionResult, Error>` — Redact all messages in a thread. Return count of messages and memories affected.

`packages/agent/src/title-generation.ts` — Thread title auto-generation:

- `generateThreadTitle(db: Database, threadId: string, llmBackend: LLMBackend, siteId: string): Promise<Result<string, Error>>` — At-most-once after the first assistant response in a thread. Check if thread already has a title — if so, return early. Send a brief prompt to the LLM asking for a short title based on the first user message and assistant response. Write the title to the thread row.

- At-most-once guarantee: the title is only generated once per thread. If the thread.title is already set, the function returns immediately.

**Testing:**
- Redact a message, verify content changed to "[redacted]" and modified_at set
- Memory tombstoning: create a memory from a thread, redact thread, verify memory soft-deleted
- Title generation: mock LLM, trigger title gen, verify thread.title updated. Call again, verify LLM not called (at-most-once).

Test file: `packages/agent/src/__tests__/redaction.test.ts` (integration — real SQLite)
Test file: `packages/agent/src/__tests__/title-generation.test.ts` (integration — mock LLM + real SQLite)

**Verification:**
Run: `bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(agent): add message redaction cascade and thread title generation`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Overlay index scanning and summary extraction

**Files:**
- Create: `packages/sandbox/src/overlay-scanner.ts`
- Create: `packages/agent/src/summary-extraction.ts`
- Modify: `packages/sandbox/src/index.ts` — add exports
- Modify: `packages/agent/src/index.ts` — add exports

**Implementation:**

`packages/sandbox/src/overlay-scanner.ts` — Overlay index scanning per spec §5.9:

- `scanOverlayIndex(db: Database, siteId: string, overlayMounts: Record<string, string>): Promise<ScanResult>` — Periodic scan of overlay mounts:
  1. Walk each mounted directory recursively
  2. For each file: compute SHA-256 content_hash
  3. Compare against existing overlay_index entry (by deterministic UUID: UUID5(site_id, path))
  4. Only write if hash changed or file is new (content-addressed scan per spec §5.15)
  5. Tombstone files that no longer exist on disk
  6. Return `{ created: number; updated: number; tombstoned: number }`

- `startOverlayScanLoop(db: Database, siteId: string, overlayMounts: Record<string, string>, intervalMs: number): { stop: () => void }` — Periodic scanning (default: every 5 minutes).

`packages/agent/src/summary-extraction.ts` — Summary and memory extraction on idle:

- `extractSummaryAndMemories(db: Database, threadId: string, llmBackend: LLMBackend, siteId: string): Promise<Result<ExtractionResult, Error>>` — When the agent is idle (no active loop for a thread), summarize recent messages and extract memory entries:
  1. Check thread.summary_through — only process messages after this point
  2. Send messages to LLM with a summarization prompt
  3. Write summary to thread.summary, update summary_through and summary_model_id
  4. Extract key facts/decisions from the conversation, write to semantic_memory

- `buildCrossThreadDigest(db: Database, userId: string): string` — Build a cross-thread activity digest for volatile context. Summarize recent activity across all threads for this user (last N messages per thread, recent task completions).

**Testing:**
- Overlay scan: create temp files, scan, verify overlay_index entries created with correct hashes. Modify a file, rescan, verify only the modified entry updated. Delete a file, rescan, verify tombstoned.
- Summary extraction: mock LLM to return a summary, verify thread.summary updated
- Cross-thread digest: create activity in multiple threads, build digest, verify it includes all threads

Test file: `packages/sandbox/src/__tests__/overlay-scanner.test.ts` (integration — real filesystem + real SQLite)
Test file: `packages/agent/src/__tests__/summary-extraction.test.ts` (integration — mock LLM + real SQLite)

**Verification:**
Run: `bun test packages/sandbox/ && bun test packages/agent/`
Expected: All tests pass

**Commit:** `feat(sandbox,agent): add overlay index scanning and summary extraction`
<!-- END_TASK_5 -->
<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 6-6) -->
<!-- START_TASK_6 -->
### Task 6: Phase 8 integration tests

**Files:**
- Create: `packages/llm/src/__tests__/multi-provider.integration.test.ts`
- Create: `packages/agent/src/__tests__/advanced-features.integration.test.ts`

**Implementation:**

`packages/llm/src/__tests__/multi-provider.integration.test.ts`:
- Create a model router with all 4 providers configured (Ollama, Anthropic, Bedrock, OpenAI-compatible)
- Verify each backend resolves correctly by ID
- Verify default backend selection
- Mock-based tests that don't require real API connections

`packages/agent/src/__tests__/advanced-features.integration.test.ts`:
- Advisory lifecycle: create → approve → apply, verify status transitions and change_log
- Redaction cascade: create messages and memories, redact, verify cascade
- Title generation: send first message, verify title generated once
- Overlay scanning: mount temp directory, scan, modify, rescan, verify incremental updates

All external service tests skippable via env vars (SKIP_ANTHROPIC, SKIP_BEDROCK, SKIP_OLLAMA).

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass across all packages

**Commit:** `test: add multi-provider and advanced feature integration tests`
<!-- END_TASK_6 -->
<!-- END_SUBCOMPONENT_C -->

<!-- START_SUBCOMPONENT_D (tasks 7-8) -->
<!-- START_TASK_7 -->
### Task 7: Metrics tables, spending ceiling wiring, and redaction API route

**Files:**
- Create: `packages/core/src/metrics-schema.ts`
- Create: `packages/web/src/server/routes/redaction.ts`
- Modify: `packages/agent/src/scheduler.ts` — wire spending ceiling to metrics
- Modify: `packages/web/src/server/routes/index.ts` — mount redaction route
- Modify: `packages/core/src/index.ts` — add exports

**Implementation:**

`packages/core/src/metrics-schema.ts` — Create metrics tables (separate metrics.db or same db):

```sql
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT,
  task_id TEXT,
  dag_root_id TEXT,
  model_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd REAL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS daily_summary (
  date TEXT PRIMARY KEY,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  turn_count INTEGER DEFAULT 0
) STRICT;
```

- `recordTurn(db: Database, turn: TurnRecord): void` — Insert turn and update daily_summary atomically.
- `getDailySpend(db: Database, date: string): number` — Query daily_summary.total_cost_usd for spending ceiling checks.

Wire Phase 4's spending ceiling stub to use `getDailySpend()` instead of always returning "within budget."

**Redaction API route (R-E18):**
- `POST /api/messages/:id/redact` — Call `redactMessage()` from `@bound/agent`, return confirmation.

**Testing:**
- Record turns, verify daily_summary updates correctly
- getDailySpend returns correct value after recording turns
- Redaction route: POST to redact endpoint, verify message content changed

Test file: `packages/core/src/__tests__/metrics.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/core/ && bun test packages/web/`
Expected: All tests pass

**Commit:** `feat(core,web): add metrics tables, spending ceiling, and redaction API route`
<!-- END_TASK_7 -->

<!-- START_TASK_8 -->
### Task 8: Cross-file thread notification (R-E20) and host header validation

**Files:**
- Create: `packages/agent/src/file-thread-tracker.ts`
- Modify: `packages/web/src/server/index.ts` — add host header middleware

**Implementation:**

`packages/agent/src/file-thread-tracker.ts` — File-thread notification per spec R-E20:

- Track which thread last discussed each file path (simple map: `Map<string, string>` persisted via semantic_memory with key prefix `_internal.file_thread.`)
- When a file is modified from a different thread than the one that last discussed it, inject a system message: "File {path} was modified from thread {other_thread_title}."
- Wire into the FS_PERSIST step of the agent loop.

**Host header validation (R-U4):**

Add Hono middleware to Phase 5's web server that validates the Host header:
```typescript
app.use("*", async (c, next) => {
  const host = c.req.header("Host");
  if (host && !isLocalhost(host)) {
    return c.json({ error: "Invalid Host header" }, 403);
  }
  await next();
});
```

Where `isLocalhost` checks for `localhost`, `127.0.0.1`, `[::1]`, and port variants.

**Testing:**
- File-thread tracking: modify a file from thread A, then from thread B, verify notification message injected
- Host header: request with valid Host header passes, request with external Host header returns 403

Test file: `packages/agent/src/__tests__/file-thread-tracker.test.ts` (integration — real SQLite)

**Verification:**
Run: `bun test packages/agent/ && bun test packages/web/`
Expected: All tests pass

**Commit:** `feat(agent,web): add file-thread notifications and host header validation`
<!-- END_TASK_8 -->
<!-- END_SUBCOMPONENT_D -->
