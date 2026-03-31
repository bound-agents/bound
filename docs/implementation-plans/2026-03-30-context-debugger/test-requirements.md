# Context Debugger -- Test Requirements

Maps each acceptance criterion from `docs/design-plans/2026-03-30-context-debugger.md` to specific tests with classification, file paths, and verification descriptions.

---

## AC1: Token Counting Utility

### context-debugger.AC1.1

**Criterion:** `countTokens("hello world")` returns a token count consistent with cl100k_base encoding.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/tokens.test.ts` |

**What to verify:** Call `countTokens("hello world")` and assert the result equals `2` (the known cl100k_base token count for this input). Also verify the return type is a positive integer.

---

### context-debugger.AC1.2

**Criterion:** `countContentTokens(content)` handles both `string` and `ContentBlock[]` inputs correctly.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/tokens.test.ts` |

**What to verify (string path):** `countContentTokens("hello world")` returns the same value as `countTokens("hello world")`.

**What to verify (ContentBlock[] path):** `countContentTokens([{ type: "text", text: "hello" }, { type: "tool_use", id: "1", name: "test", input: {} }])` returns the sum of: the text block's token count via `countTokens("hello")`, plus the JSON-stringified tool_use block's token count via `countTokens(JSON.stringify({...}))`.

---

### context-debugger.AC1.3

**Criterion:** All `estimateContentLength() / 4` call sites in context-assembly.ts replaced with `countContentTokens()`.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit + static (grep) |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` (existing tests) |

**What to verify:** Run the existing context-assembly test suite; all tests pass with the new token counting backend. Additionally, a static grep of `context-assembly.ts` for `estimateContentLength.*/ 4` or `estimateContentLength.*\/\s*4` should return zero matches, confirming all heuristic call sites have been replaced. The `estimateContentLength` function itself may still exist (with a `@deprecated` annotation) but must not be called in any token-estimation code path.

---

### context-debugger.AC1.4

**Criterion:** Encoding singleton initializes lazily on first call, not at import time.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/tokens.test.ts` |

**What to verify:** Import the module. Verify that `countTokens` is callable and returns a correct result on first invocation (proving the lazy singleton initializes on demand without prior setup). A stricter variant: if the module exports a test hook or the internal `encoding` variable is accessible, assert it is `null` before the first `countTokens` call and non-null after. If no such hook exists, the pragmatic test is sufficient -- calling `countTokens` on first invocation succeeds without error.

---

### context-debugger.AC1.5

**Criterion:** Empty string input returns 0 tokens.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/shared/src/__tests__/tokens.test.ts` |

**What to verify:** `countTokens("")` returns exactly `0`. `countContentTokens("")` returns exactly `0`. `countContentTokens([])` (empty array) returns exactly `0`.

---

## AC2: Context Assembly Instrumentation

### context-debugger.AC2.1

**Criterion:** `assembleContext()` returns `{ messages, debug }` where debug contains `contextWindow`, `totalEstimated`, `model`, and `sections`.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Call `assembleContext()` with a thread containing at least one user message and one assistant message. The return value has shape `{ messages: LLMMessage[], debug: ContextDebugInfo }`. Assert `debug.contextWindow` is a positive number, `debug.totalEstimated` is a non-negative number, `debug.model` is a non-empty string, and `debug.sections` is a non-empty array where each entry has `name` (string) and `tokens` (number). Also verify the agent loop correctly destructures `{ messages, debug }` by running existing agent loop tests without regression.

---

### context-debugger.AC2.2

**Criterion:** Sections include system, tools, history (with user/assistant/tool_result children), memory, task-digest, skill-context, volatile-other.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Construct a `ContextParams` that exercises all section types: a system prompt, tool token estimate > 0, multi-message history with user/assistant/tool_result roles, semantic memory entries, task digest data, an active skill, and additional volatile content. Assert `debug.sections` contains entries with names `"system"`, `"tools"`, `"history"`, `"memory"`, `"task-digest"`, `"skill-context"`, and `"volatile-other"`. Assert the `"history"` section has a `children` array containing entries named `"user"`, `"assistant"`, and `"tool_result"`.

---

### context-debugger.AC2.3

**Criterion:** Sum of all section tokens equals `totalEstimated`.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** For every `assembleContext()` call in the test suite (both simple and complex scenarios), compute `debug.sections.reduce((sum, s) => sum + s.tokens, 0)` and assert it equals `debug.totalEstimated`. This invariant must hold across: normal assembly, budget-pressure assembly, truncation assembly, empty-history assembly, and noHistory (autonomous) assembly.

---

### context-debugger.AC2.4

**Criterion:** `budgetPressure` is true when Stage 7 triggers enrichment reduction.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Call `assembleContext()` with `contextWindow` set to a value small enough that the assembled content exceeds the headroom threshold (< 2000 tokens remaining), triggering Stage 7 budget pressure. Assert `debug.budgetPressure === true`. In a separate test with a generous `contextWindow`, assert `debug.budgetPressure === false`.

---

### context-debugger.AC2.5

**Criterion:** `truncated` reflects number of messages dropped during history truncation.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Insert a thread with many messages (e.g., 50 user/assistant pairs) and call `assembleContext()` with a `contextWindow` small enough to force history truncation. Assert `debug.truncated > 0` and that the value equals the number of history messages that were dropped (original count minus remaining count). In a separate test with ample context window, assert `debug.truncated === 0`.

---

### context-debugger.AC2.6

**Criterion:** Assembly with empty thread (no history) returns sections with 0-token history and no children.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |

**What to verify:** Call `assembleContext()` with a thread that has zero messages in its history. Find the `"history"` section in `debug.sections`. Assert `historySection.tokens === 0` and `historySection.children` is either `undefined` or an empty array.

---

## AC3: Persistence Layer

### context-debugger.AC3.1

**Criterion:** `context_debug` column added to turns table via idempotent ALTER TABLE.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/core/src/__tests__/metrics-schema.test.ts` |

**What to verify:** Create a temp database, apply the base schema, then call `ensureMetricsSchema(db)`. Query `PRAGMA table_info(turns)` and assert a column named `context_debug` exists with type `TEXT`. Insert a row into `turns` without specifying `context_debug` and verify the column is accessible and defaults to `NULL`.

---

### context-debugger.AC3.2

**Criterion:** `recordContextDebug(db, turnId, debug)` stores valid JSON retrievable by turn ID.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/core/src/__tests__/metrics-schema.test.ts` |

**What to verify:** Create a temp database, apply schema, call `recordTurn()` to get a `turnId`. Construct a `ContextDebugInfo` object with known values. Call `recordContextDebug(db, turnId, debugObj)`. Query `SELECT context_debug FROM turns WHERE id = ?` with the turnId. Parse the result with `JSON.parse()` and assert deep equality with the original debug object (round-trip fidelity).

---

### context-debugger.AC3.3

**Criterion:** Schema migration is idempotent (re-running does not error).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/core/src/__tests__/metrics-schema.test.ts` |

**What to verify:** Create a temp database, apply the base schema, then call `ensureMetricsSchema(db)` twice in sequence. No error is thrown on the second call. Verify the `context_debug` column still exists and functions correctly after the double application.

---

### context-debugger.AC3.4

**Criterion:** Turns created before the migration have NULL context_debug (no backfill).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Unit |
| Test file | `packages/core/src/__tests__/metrics-schema.test.ts` |

**What to verify:** Create a temp database, apply the base schema. Insert a turn row directly via SQL (before calling `ensureMetricsSchema`). Then call `ensureMetricsSchema(db)` to add the column. Query the pre-existing turn row and assert `context_debug IS NULL`. This proves no backfill occurs.

---

## AC4: API + WebSocket Delivery

### context-debugger.AC4.1

**Criterion:** `GET /api/threads/:id/context-debug` returns array of turn debug records ordered by created_at ASC.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |

**What to verify:** Set up a test Hono app with the threads router and a temp SQLite database. Insert 3 turns for a thread with `context_debug` JSON and distinct `created_at` timestamps (e.g., T1 < T2 < T3). Call `GET /api/threads/:id/context-debug`. Assert the response is a JSON array of length 3, and that `result[0].created_at < result[1].created_at < result[2].created_at`.

---

### context-debugger.AC4.2

**Criterion:** Each record includes turn_id, model_id, tokens_in (actual), tokens_out, context_debug (parsed), created_at.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |

**What to verify:** From the same API response as AC4.1, assert each record in the array has all six fields: `turn_id` (number), `model_id` (string), `tokens_in` (number), `tokens_out` (number), `context_debug` (object with `contextWindow`, `totalEstimated`, `model`, `sections`, `budgetPressure`, `truncated`), and `created_at` (string). Verify `context_debug` is a parsed object (not a raw JSON string).

---

### context-debugger.AC4.3

**Criterion:** WebSocket `context:debug` event delivered to clients subscribed to the thread.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/web/src/server/__tests__/websocket-context-debug.test.ts` or `packages/agent/src/__tests__/agent-loop.test.ts` |

**What to verify (WebSocket handler):** Set up a mock WebSocket client subscribed to a thread. Emit a `context:debug` event on the eventBus with `{ thread_id, turn_id, debug }`. Assert the mock client receives a JSON message with `type: "context:debug"` and `data: { turn_id, debug }`. Verify that a client NOT subscribed to that thread does NOT receive the message.

**What to verify (agent loop emission):** In an agent loop integration test, subscribe to the eventBus `context:debug` event. Run a turn through the loop. Assert the event fires with `thread_id` matching the loop's thread, `turn_id` matching the recorded turn, and `debug` containing a valid `ContextDebugInfo` object.

---

### context-debugger.AC4.4

**Criterion:** `GET /api/threads/:id/context-debug` for nonexistent thread returns empty array (not error).

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |

**What to verify:** Call `GET /api/threads/nonexistent-uuid/context-debug`. Assert the response status is 200 and the body is an empty JSON array `[]`.

---

### context-debugger.AC4.5

**Criterion:** Turns with NULL context_debug are excluded from the response.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | Integration |
| Test file | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |

**What to verify:** Insert 3 turns for a thread: turn A with valid `context_debug`, turn B with `context_debug = NULL`, turn C with valid `context_debug`. Call `GET /api/threads/:id/context-debug`. Assert the response array has length 2, containing only turns A and C.

---

## AC5: Debug Side Panel UI

### Classification Methodology

AC5 criteria cover frontend UI behavior. Each criterion is classified as either **Playwright e2e** (automatable) or **human visual verification** based on whether the behavior can be reliably asserted through DOM state inspection and interaction simulation, versus requiring subjective visual judgment about rendering fidelity, color accuracy, or layout aesthetics.

Criteria that test **state transitions, data presence, DOM structure, and user interactions** (click, navigate, assert text content) are automatable via Playwright. Criteria that test **visual proportionality, color rendering, SVG path accuracy, or aesthetic layout** require human verification because Playwright cannot meaningfully assert that a flex-basis percentage "looks proportional" or that a color matches a design spec without pixel-level screenshot comparison (which is brittle and not set up in this project).

---

### context-debugger.AC5.1

**Criterion:** Toggle button in thread header opens/closes the debug panel.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Navigate to a thread view. Assert the debug panel (`[class*="debug-panel"]`) is not visible. Click the debug toggle button (`[class*="debug-toggle"]`). Assert the debug panel is now visible. Click the toggle again. Assert the panel is hidden.

**Justification:** Toggle behavior is a DOM visibility state change, fully automatable via `isVisible()` assertions.

---

### context-debugger.AC5.2

**Criterion:** Panel is closed by default on page load.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Navigate to a thread view (fresh page load). Assert the debug panel element is either absent from the DOM or has `display: none` / is not visible. No user interaction should be required.

**Justification:** Default visibility state is a straightforward DOM assertion.

---

### context-debugger.AC5.3

**Criterion:** Panel fetches historical turn data on first open.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Navigate to a thread that has at least one completed agent turn. Click the debug toggle to open the panel. Wait for loading state to resolve. Assert the panel contains turn data: a "Turn N of M" label where M >= 1, and at least one section row with token counts visible. Optionally intercept the network request to `GET /api/threads/:id/context-debug` and assert it was made.

**Justification:** Network request interception and subsequent DOM content assertion are standard Playwright capabilities.

---

### context-debugger.AC5.4

**Criterion:** Panel receives and appends live turn data via WebSocket.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Open a thread with the debug panel visible and note the current turn count (M). Send a new message to the thread and wait for the agent to complete a turn. Assert the turn count label updates to "Turn N of M+1" (or the turn count increases by 1). Verify the new turn's data is visible without requiring a manual refresh or panel re-open.

**Justification:** This tests WebSocket-driven DOM updates, which Playwright can observe by polling for text changes. Requires a running agent backend, so this is an e2e test with real agent execution (or a mock backend that emits WebSocket events).

---

### context-debugger.AC5.5

**Criterion:** Proportional stacked bar renders sections with correct Tokyo Metro colors and proportional widths.

| Field | Value |
|---|---|
| Verification | **Hybrid** -- structure automated, visual human-verified |
| Test type | e2e (Playwright) for structure; human for visual |
| Test file | `tests/e2e/context-debugger.spec.ts` (structural), human visual inspection |

**Automated (Playwright):** Open the debug panel with turn data. Assert the `.context-bar` element exists and contains multiple `.bar-segment` children. Assert each segment has a non-zero computed width. Assert the number of segments matches the number of non-zero sections in the debug data.

**Human verification:** Visually inspect that segment widths are proportional to their token counts (e.g., if history is 60% of tokens, its segment occupies roughly 60% of the bar). Verify each segment color matches the Tokyo Metro color mapping from the design (Ginza orange for system, Marunouchi red for tools, etc.). Verify the free-space segment renders in muted gray at reduced opacity.

**Justification:** DOM structure and element existence are automatable. Color correctness and visual proportionality require subjective judgment -- Playwright can read `computed style` values but asserting that `rgb(255, 145, 0)` "looks like Ginza orange" or that a 60% flex-basis "looks proportional" is fragile and requires a human eye. The project does not use visual regression screenshot testing.

---

### context-debugger.AC5.6

**Criterion:** Section list shows name, token count, and percentage for each section.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Open the debug panel with turn data. For each `.section-row` element, assert it contains: a `.name` element with non-empty text, a `.tokens` element with a numeric string (containing commas/digits), and a `.pct` element matching the pattern `\d+\.\d+%`. Assert the number of section rows matches the expected section count (sections + free space).

**Justification:** Text content and DOM structure assertions are fully automatable. The data is deterministic given the backend state.

---

### context-debugger.AC5.7

**Criterion:** History section expands to show user/assistant/tool_result children.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Open the debug panel for a thread with history containing all three roles. Locate the section row with name "history". Assert it has a clickable chevron/toggle. Click it. Assert child rows appear (`.section-row.child`) with names "user", "assistant", and/or "tool_result". Click again. Assert child rows are hidden.

**Justification:** Expand/collapse behavior is a DOM interaction + visibility assertion, fully automatable.

---

### context-debugger.AC5.8

**Criterion:** Turn navigation arrows browse between turns, with latest selected by default.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Open the debug panel for a thread with 3+ turns. Assert the label reads "Turn 3 of 3" (latest selected by default) and a "Latest" badge is visible. Click the previous arrow (`<`). Assert the label updates to "Turn 2 of 3" and the "Latest" badge disappears. Click previous again. Assert "Turn 1 of 3" and the previous button is disabled. Click the next arrow (`>`). Assert "Turn 2 of 3". Verify the displayed section data changes between turns (e.g., `totalEstimated` value updates).

**Justification:** Button click interactions and text label assertions are standard Playwright capabilities.

---

### context-debugger.AC5.9

**Criterion:** Sparkline SVG chart shows token usage trend across turns with selected turn highlighted.

| Field | Value |
|---|---|
| Verification | **Hybrid** -- structure automated, visual human-verified |
| Test type | e2e (Playwright) for structure; human for visual |
| Test file | `tests/e2e/context-debugger.spec.ts` (structural), human visual inspection |

**Automated (Playwright):** Open the debug panel for a thread with 5+ turns. Assert the `.sparkline-container` element exists and contains an `<svg>` element. Assert the SVG contains a `<polyline>` (the trend line), a `<path>` (the area fill), and a `<circle>` (the selected turn highlight). Assert the `<circle>` element has non-zero `cx`/`cy` attributes. Click a different hit area in the sparkline; assert the turn label updates (the `onSelectTurn` callback fires and the panel switches turns).

**Human verification:** Visually inspect that the line chart shows a meaningful trend (not a flat line or garbled path). Verify the highlighted dot corresponds to the selected turn's position. Verify the area fill uses the expected Namboku emerald color at reduced opacity.

**Justification:** SVG element existence and attribute presence are automatable. Whether the sparkline "looks like a proper trend chart" and whether the highlight dot is visually positioned correctly require human judgment. SVG path coordinates are computed from data and floating-point rounding makes exact assertions brittle.

---

### context-debugger.AC5.10

**Criterion:** Actual vs estimated token line displays both values when actual is available.

| Field | Value |
|---|---|
| Verification | Automated |
| Test type | e2e (Playwright) |
| Test file | `tests/e2e/context-debugger.spec.ts` |

**What to verify:** Open the debug panel for a completed turn where the LLM reported actual token usage (`tokens_in > 0`). Assert the panel displays both an "Estimated:" line with a token count and an "Actual (API):" line with a token count. Assert a "Variance:" line is visible showing the difference and percentage. Verify the estimated and actual values are different numbers (since cl100k_base is an approximation, exact equality would be surprising). For a turn where `tokens_in` is 0 or null, assert the "Actual (API):" line is not rendered.

**Justification:** Text presence and content assertions are straightforward Playwright operations. The conditional rendering (actual present vs absent) is a standard DOM visibility check.

---

## Summary Table

| AC | Criterion (short) | Automated? | Type | Test File |
|---|---|---|---|---|
| AC1.1 | countTokens basic | Yes | Unit | `packages/shared/src/__tests__/tokens.test.ts` |
| AC1.2 | countContentTokens string+blocks | Yes | Unit | `packages/shared/src/__tests__/tokens.test.ts` |
| AC1.3 | All heuristic call sites replaced | Yes | Unit + grep | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC1.4 | Lazy singleton init | Yes | Unit | `packages/shared/src/__tests__/tokens.test.ts` |
| AC1.5 | Empty string returns 0 | Yes | Unit | `packages/shared/src/__tests__/tokens.test.ts` |
| AC2.1 | assembleContext returns { messages, debug } | Yes | Unit | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC2.2 | All section names present with children | Yes | Unit | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC2.3 | Section sum equals totalEstimated | Yes | Unit | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC2.4 | budgetPressure flag | Yes | Unit | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC2.5 | truncated count | Yes | Unit | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC2.6 | Empty history sections | Yes | Unit | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC3.1 | context_debug column exists | Yes | Unit | `packages/core/src/__tests__/metrics-schema.test.ts` |
| AC3.2 | recordContextDebug round-trip | Yes | Unit | `packages/core/src/__tests__/metrics-schema.test.ts` |
| AC3.3 | Idempotent migration | Yes | Unit | `packages/core/src/__tests__/metrics-schema.test.ts` |
| AC3.4 | Pre-migration turns have NULL | Yes | Unit | `packages/core/src/__tests__/metrics-schema.test.ts` |
| AC4.1 | API returns ordered array | Yes | Integration | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |
| AC4.2 | Record includes all fields | Yes | Integration | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |
| AC4.3 | WebSocket event delivery | Yes | Integration | `packages/web/src/server/__tests__/websocket-context-debug.test.ts` |
| AC4.4 | Nonexistent thread returns [] | Yes | Integration | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |
| AC4.5 | NULL context_debug excluded | Yes | Integration | `packages/web/src/server/__tests__/threads-context-debug.test.ts` |
| AC5.1 | Toggle opens/closes panel | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.2 | Panel closed by default | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.3 | Fetches historical data on open | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.4 | Live WebSocket updates | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.5 | Proportional bar with colors | Hybrid | e2e + human | `tests/e2e/context-debugger.spec.ts` + visual |
| AC5.6 | Section list with counts/pct | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.7 | History expand/collapse | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.8 | Turn navigation arrows | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |
| AC5.9 | Sparkline SVG chart | Hybrid | e2e + human | `tests/e2e/context-debugger.spec.ts` + visual |
| AC5.10 | Actual vs estimated display | Yes | e2e | `tests/e2e/context-debugger.spec.ts` |

### Counts

- **Fully automated:** 28 of 30 criteria
- **Hybrid (automated structure + human visual):** 2 of 30 (AC5.5, AC5.9)
- **Human-only:** 0 of 30

### Test Files Created

| File | Package | Type | Criteria Covered |
|---|---|---|---|
| `packages/shared/src/__tests__/tokens.test.ts` | shared | Unit | AC1.1, AC1.2, AC1.4, AC1.5 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | agent | Unit (additions) | AC1.3, AC2.1--AC2.6 |
| `packages/core/src/__tests__/metrics-schema.test.ts` | core | Unit (additions) | AC3.1--AC3.4 |
| `packages/web/src/server/__tests__/threads-context-debug.test.ts` | web | Integration | AC4.1, AC4.2, AC4.4, AC4.5 |
| `packages/web/src/server/__tests__/websocket-context-debug.test.ts` | web | Integration | AC4.3 |
| `tests/e2e/context-debugger.spec.ts` | root | e2e (Playwright) | AC5.1--AC5.10 |
