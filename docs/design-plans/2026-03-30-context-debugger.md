# Context Debugger Design

## Summary

This feature adds real-time visibility into how the agent's context window is allocated during each conversation turn. Currently, the system uses a rough heuristic (divide character count by 4) to estimate token usage, making it difficult to understand why context budget pressure occurs or how different sections (system prompt, tool definitions, conversation history, semantic memory, task digest, skills, etc.) compete for space. The new context debugger replaces this heuristic with accurate tiktoken-based token counting and instruments the context assembly pipeline to track per-section token allocations.

The implementation flows from the agent's internal pipeline to a new collapsible side panel in the web UI. During each agent loop, the context assembly stage now returns structured metadata alongside the final message array, capturing token counts for each section and subsection. This metadata is persisted in a new database column, exposed via REST API for historical browsing, and pushed via WebSocket for live updates. The frontend renders this data as a proportional stacked bar chart (using Tokyo Metro line colors for visual consistency), an expandable section list with drill-down into conversation history by role, and a sparkline showing token usage trends across turns. This gives operators and developers concrete visibility into context pressure, helping diagnose issues like memory eviction, truncated history, or skill context crowding.

## Definition of Done

1. **Token estimation upgrade**: All `estimateContentLength() / 4` usage replaced with tiktoken-based counting across the project. Exported as a shared utility.

2. **Context assembly instrumentation**: `assembleContext()` returns structured metadata alongside messages -- per-section token counts (system prompt, tool definitions, history by role, semantic memory, task digest, skill context, volatile other, free space), plus turn-level totals.

3. **Persistence layer**: New DB table (or extension to `turns`) storing per-section token breakdown for each turn, enabling historical browsing.

4. **API + WebSocket delivery**: New endpoint serving context debug data for a thread's turns. WebSocket event pushed when new turn data is available.

5. **Debug side panel UI**: Collapsible side panel in LineView (closed by default) showing a `/context`-inspired visual breakdown -- colored proportional bar, section list with token counts/percentages, drill-down into sub-categories, turn navigation, and a sparkline/mini-chart of context growth across turns.

**Out of scope**: Pipeline stage internals, per-message token attribution, cost breakdown in the panel.

## Acceptance Criteria

### context-debugger.AC1: Token Counting Utility
- **context-debugger.AC1.1 Success:** `countTokens("hello world")` returns a token count consistent with cl100k_base encoding
- **context-debugger.AC1.2 Success:** `countContentTokens(content)` handles both `string` and `ContentBlock[]` inputs correctly
- **context-debugger.AC1.3 Success:** All `estimateContentLength() / 4` call sites in context-assembly.ts replaced with `countContentTokens()`
- **context-debugger.AC1.4 Edge:** Encoding singleton initializes lazily on first call, not at import time
- **context-debugger.AC1.5 Edge:** Empty string input returns 0 tokens

### context-debugger.AC2: Context Assembly Instrumentation
- **context-debugger.AC2.1 Success:** `assembleContext()` returns `{ messages, debug }` where debug contains `contextWindow`, `totalEstimated`, `model`, and `sections`
- **context-debugger.AC2.2 Success:** Sections include system, tools, history (with user/assistant/tool_result children), memory, task-digest, skill-context, volatile-other
- **context-debugger.AC2.3 Success:** Sum of all section tokens equals `totalEstimated`
- **context-debugger.AC2.4 Success:** `budgetPressure` is true when Stage 7 triggers enrichment reduction
- **context-debugger.AC2.5 Success:** `truncated` reflects number of messages dropped during history truncation
- **context-debugger.AC2.6 Edge:** Assembly with empty thread (no history) returns sections with 0-token history and no children

### context-debugger.AC3: Persistence Layer
- **context-debugger.AC3.1 Success:** `context_debug` column added to turns table via idempotent ALTER TABLE
- **context-debugger.AC3.2 Success:** `recordContextDebug(db, turnId, debug)` stores valid JSON retrievable by turn ID
- **context-debugger.AC3.3 Success:** Schema migration is idempotent (re-running does not error)
- **context-debugger.AC3.4 Edge:** Turns created before the migration have NULL context_debug (no backfill)

### context-debugger.AC4: API + WebSocket Delivery
- **context-debugger.AC4.1 Success:** `GET /api/threads/:id/context-debug` returns array of turn debug records ordered by created_at ASC
- **context-debugger.AC4.2 Success:** Each record includes turn_id, model_id, tokens_in (actual), tokens_out, context_debug (parsed), created_at
- **context-debugger.AC4.3 Success:** WebSocket `context:debug` event delivered to clients subscribed to the thread
- **context-debugger.AC4.4 Failure:** `GET /api/threads/:id/context-debug` for nonexistent thread returns empty array (not error)
- **context-debugger.AC4.5 Edge:** Turns with NULL context_debug are excluded from the response

### context-debugger.AC5: Debug Side Panel UI
- **context-debugger.AC5.1 Success:** Toggle button in thread header opens/closes the debug panel
- **context-debugger.AC5.2 Success:** Panel is closed by default on page load
- **context-debugger.AC5.3 Success:** Panel fetches historical turn data on first open
- **context-debugger.AC5.4 Success:** Panel receives and appends live turn data via WebSocket
- **context-debugger.AC5.5 Success:** Proportional stacked bar renders sections with correct Tokyo Metro colors and proportional widths
- **context-debugger.AC5.6 Success:** Section list shows name, token count, and percentage for each section
- **context-debugger.AC5.7 Success:** History section expands to show user/assistant/tool_result children
- **context-debugger.AC5.8 Success:** Turn navigation arrows browse between turns, with latest selected by default
- **context-debugger.AC5.9 Success:** Sparkline SVG chart shows token usage trend across turns with selected turn highlighted
- **context-debugger.AC5.10 Success:** Actual vs estimated token line displays both values when actual is available

## Glossary

- **Context window**: The maximum number of tokens an LLM can process in a single request, including both the input prompt and space for the model's response.
- **Context assembly pipeline**: The multi-stage process in the agent loop that gathers and orders all pieces of context (system prompt, tools, history, memory, etc.) into a final array of messages sent to the LLM.
- **Token**: The atomic unit of text that language models process; roughly 0.75 words in English. Different models use different tokenization schemes.
- **tiktoken / cl100k_base**: OpenAI's tokenization library and the specific encoding used by GPT-4 and similar models. Used here as an approximation for Claude's token counting.
- **Budget pressure**: A state during context assembly when the total estimated tokens approach or exceed the model's context window, triggering reduction strategies like memory cap lowering or history truncation.
- **Semantic memory**: The agent's long-term memory store, persisted in the `semantic_memory` table, containing facts and observations extracted from prior conversations.
- **Task digest**: A summary of scheduled and recently completed autonomous tasks, injected into the context to inform the agent of background activities.
- **Skill context**: Content from active skill files (SKILL.md format) that extends the agent's capabilities, injected into context when relevant to the current task.
- **Volatile context**: Dynamically generated context that changes between turns even when history doesn't, such as delta-based memory enrichment, active skill index, and recent advisory notifications.
- **Stage 5.5 / volatile enrichment**: A specific stage in the context assembly pipeline that generates delta-based memory and task summaries, showing only items changed since the last turn rather than dumping all semantic memory.
- **Turn**: A single request-response cycle in the agent loop, recorded in the `turns` table with metadata like token counts and timing.
- **WebSocket subscription**: A mechanism where the web client maintains a persistent connection to the server and registers interest in specific thread updates, receiving live events as they occur.
- **Tokyo Metro colors**: The color scheme used throughout Bound's UI, mapping each context section to a specific Tokyo subway line color for visual consistency.
- **Idempotent ALTER TABLE**: A database migration pattern where schema changes are wrapped in try/catch blocks so they can be safely re-run without failing if the column already exists.
- **Sparkline**: A small, simple line chart (typically without axes or labels) designed to show trends inline with text, used here to visualize token usage growth across conversation turns.

## Architecture

Context debug data originates in the agent's context assembly pipeline, flows through persistence and event delivery, and is rendered in a collapsible side panel in the web UI.

### Token Counting

A shared utility wraps `js-tiktoken` with the `cl100k_base` encoding to replace all `estimateContentLength() / 4` heuristics. Provides sync `countTokens(text: string): number` and `countContentTokens(content: string | ContentBlock[]): number` functions. The encoding is initialized once (lazy singleton). Counts are labeled "estimated" in the UI; actual API-reported token counts from the LLM response are shown alongside when available.

### Context Assembly Metadata

`assembleContext()` returns a result object instead of bare `LLMMessage[]`:

```typescript
interface ContextAssemblyResult {
  messages: LLMMessage[];
  debug: ContextDebugInfo;
}

interface ContextDebugInfo {
  contextWindow: number;
  totalEstimated: number;
  model: string;
  sections: ContextSection[];
  budgetPressure: boolean;
  truncated: number;
}

interface ContextSection {
  name: string;
  tokens: number;
  children?: ContextSection[];
}
```

Sections are counted during assembly (not in a separate pass). Each identifiable chunk of the assembled context maps to a named section: `system`, `tools`, `history` (with `user`/`assistant`/`tool_result` children), `memory`, `task-digest`, `skill-context`, `volatile-other`. Free space is derived as `contextWindow - totalEstimated`.

### Persistence & Delivery

A new `context_debug TEXT` column on the `turns` table stores the serialized `ContextDebugInfo` JSON per turn. Written via `recordContextDebug(db, turnId, debug)` immediately after `recordTurn()`, following the same pattern as `recordTurnRelayMetrics()`.

A new `"context:debug"` event in `EventMap` carries `{ thread_id, turn_id, debug }`. The WebSocket handler forwards it to clients subscribed to the thread. A new `GET /api/threads/:id/context-debug` endpoint returns all turns with context debug data for historical browsing.

### Frontend

`LineView.svelte` shifts from a single centered column to a flex row. A 320px collapsible `ContextDebugPanel` sits on the right, closed by default, toggled by a header button.

The panel fetches historical data on first open (`GET /api/threads/:id/context-debug`), then appends live updates via the `context:debug` WebSocket event. Turn navigation (`<< Turn N of M >>`) selects which turn's breakdown to display.

Four new Svelte components:
- `ContextDebugPanel.svelte` -- data fetching, turn navigation, layout
- `ContextBar.svelte` -- horizontal stacked proportional bar with Tokyo Metro colors
- `ContextSectionList.svelte` -- hierarchical section breakdown with expand/collapse
- `ContextSparkline.svelte` -- SVG area chart of token usage across turns

### Color Mapping

Each context section maps to a stable Tokyo Metro line color:

| Section | CSS Variable | Color |
|---------|-------------|-------|
| System prompt | `--line-0` | Ginza orange |
| Tool definitions | `--line-1` | Marunouchi red |
| History | `--line-6` | Hanzomon purple |
| Semantic memory | `--line-4` | Chiyoda green |
| Task digest | `--line-3` | Tozai sky blue |
| Skill context | `--line-5` | Yurakucho gold |
| Volatile other | `--line-7` | Namboku emerald |
| Free space | `--text-muted` | Neutral gray |

## Existing Patterns

### Schema Extension

The `turns` table already uses idempotent `ALTER TABLE ADD COLUMN` with `try/catch` for `relay_target`, `relay_latency_ms`, `tokens_cache_write`, and `tokens_cache_read` in `packages/core/src/metrics-schema.ts`. The `context_debug` column follows this exact pattern.

### Post-Insert Update

`recordTurnRelayMetrics(db, turnId, relayTarget, relayLatencyMs)` updates the `turns` row after initial insertion. `recordContextDebug()` follows the same pattern -- `recordTurn()` returns the row ID, then a separate update writes the debug JSON.

### WebSocket Event Forwarding

`packages/web/src/server/websocket.ts` uses `createWebSocketHandler(eventBus)` with per-event handler functions that iterate connected clients, check `conn.subscriptions.has(threadId)`, and send filtered JSON. Events are registered on the `TypedEventEmitter` via `eventBus.on()`. The `context:debug` handler follows this pattern exactly.

### Event Type Registration

Event types live in `EventMap` interface in `packages/shared/src/events.ts`. Adding `"context:debug"` follows the same pattern as `"message:created"`, `"alert:created"`, etc.

### Status Polling

`LineView.svelte` already polls `GET /api/threads/:id/status` at 5-second intervals and subscribes to WebSocket events. The context debug panel reuses both patterns -- WebSocket for live turn data, API fetch for historical data on panel open.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Token Counting Utility

**Goal:** Replace all `estimateContentLength() / 4` heuristics with `js-tiktoken`-based counting.

**Components:**
- `js-tiktoken` dependency added to `packages/shared/package.json`
- Token counting module in `packages/shared/src/tokens.ts` -- `countTokens()`, `countContentTokens()`, lazy singleton encoding
- Updated call sites in `packages/agent/src/context-assembly.ts` -- all `Math.ceil(estimateContentLength(...) / 4)` replaced
- Deprecation or removal of `estimateContentLength()` from `context-assembly.ts`

**Dependencies:** None (first phase)

**Done when:** All token estimation uses `js-tiktoken`, existing tests pass, `countTokens("hello world")` returns a reasonable token count

**Covers:** `context-debugger.AC1.*`
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Context Assembly Instrumentation

**Goal:** `assembleContext()` returns structured metadata alongside messages with per-section token counts.

**Components:**
- `ContextAssemblyResult`, `ContextDebugInfo`, `ContextSection` types in `packages/shared/src/types.ts`
- Modified `assembleContext()` in `packages/agent/src/context-assembly.ts` -- returns `ContextAssemblyResult` instead of `LLMMessage[]`, counts tokens per section during assembly
- Updated agent loop in `packages/agent/src/agent-loop.ts` -- destructures `{ messages, debug }` from assembly result

**Dependencies:** Phase 1 (token counting utility)

**Done when:** `assembleContext()` returns correct per-section token counts for system, tools, history (with role children), memory, task digest, skill context, and volatile other. Budget pressure and truncation are tracked.

**Covers:** `context-debugger.AC2.*`
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Persistence, API & Event Delivery

**Goal:** Context debug data persisted per turn, accessible via API and pushed via WebSocket.

**Components:**
- `context_debug TEXT` column on `turns` table via idempotent ALTER TABLE in `packages/core/src/metrics-schema.ts`
- `recordContextDebug()` function in `packages/core/src/metrics-schema.ts`
- `"context:debug"` event type in `EventMap` in `packages/shared/src/events.ts`
- WebSocket handler in `packages/web/src/server/websocket.ts`
- `GET /api/threads/:id/context-debug` route in `packages/web/src/server/routes/threads.ts`
- Agent loop emits `context:debug` event after recording in `packages/agent/src/agent-loop.ts`

**Dependencies:** Phase 2 (instrumented context assembly)

**Done when:** Context debug JSON stored on each turn, retrievable via API, pushed to subscribed WebSocket clients on new turns.

**Covers:** `context-debugger.AC3.*`, `context-debugger.AC4.*`
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Side Panel Layout & Data Flow

**Goal:** Collapsible debug panel in the thread view with data fetching and turn navigation.

**Components:**
- `ContextDebugPanel.svelte` in `packages/web/src/client/components/`
- Layout changes in `packages/web/src/client/views/LineView.svelte` -- flex row wrapper, toggle button in header
- Data fetching logic -- initial API fetch on panel open, WebSocket subscription for live updates
- Turn navigation state -- `selectedTurnIdx`, arrow buttons, "latest" badge

**Dependencies:** Phase 3 (API and WebSocket delivery)

**Done when:** Panel opens/closes from header button, loads historical turns on open, receives live turn data via WebSocket, turn navigation works with arrow buttons.

**Covers:** `context-debugger.AC5.1` through `context-debugger.AC5.4`
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Visualization Components

**Goal:** Visual breakdown with colored bar, section list, and sparkline chart.

**Components:**
- `ContextBar.svelte` in `packages/web/src/client/components/` -- horizontal stacked bar with metro colors, flex-basis proportional segments
- `ContextSectionList.svelte` in `packages/web/src/client/components/` -- section rows with colored dots, token counts, percentages, expandable history drill-down
- `ContextSparkline.svelte` in `packages/web/src/client/components/` -- SVG area chart of total tokens across turns, selected turn dot highlight
- Actual vs estimated display line in panel header

**Dependencies:** Phase 4 (panel layout and data flow)

**Done when:** Proportional bar renders correctly for section data, section list shows hierarchical breakdown with expand/collapse, sparkline shows token growth trend across turns, actual vs estimated tokens displayed.

**Covers:** `context-debugger.AC5.5` through `context-debugger.AC5.8`
<!-- END_PHASE_5 -->

## Additional Considerations

**Token count accuracy:** `cl100k_base` is an approximation for Claude models (~5-10% variance). The panel labels section counts as "estimated" and shows actual API-reported totals alongside. This variance is acceptable for a debug/diagnostic view.

**Relay and delegated loops:** When a turn is executed on a remote host via relay, the context assembly happens remotely. The `context_debug` column will be NULL for relay turns unless the remote host populates it. Initial implementation leaves relay turns without debug data; a future enhancement could relay the debug metadata back via `StatusForwardPayload`.

**Panel performance:** The sparkline and bar render from pre-computed data (no client-side token counting). Even threads with hundreds of turns should render efficiently since each turn's debug data is a small JSON blob (~500 bytes).
