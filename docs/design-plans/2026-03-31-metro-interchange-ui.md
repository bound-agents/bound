# Metro Interchange UI Design

## Summary

This design adds a visual metaphor of a Tokyo Metro interchange to Bound's thread view, making cross-thread context usage visible to users. When the agent pulls context from other conversations, the UI will display this like a metro map: a vertical rail in the current thread's color runs down the message list, with colored branch lines extending from turns where cross-thread context was used, each terminating in a station marker showing the source thread's letter code. The backend already generates cross-thread digests as text for the LLM; this work surfaces structured metadata (thread IDs, titles, colors, activity timestamps) through the existing context debug pipeline so the frontend can render the interchange visualization.

The design also tightens the thread view's visual density and consistency with the app's Tokyo Metro aesthetic. Messages wrap in a dark panel matching the Timetable view's data table style. Padding, margins, and widths shrink across all elements for higher information density. All letter-in-circle badges (thread line markers, host badges) adopt authentic Tokyo Metro signage: a colored outer circle with a white inner circle and bold black text. These changes are independent but coordinated — the compact layout creates space for the rail visualization, and the circle icon updates ensure visual consistency across the new interchange markers and existing UI elements.

## Definition of Done

1. **Compact LineView** — Reduced padding/margins throughout (header, messages, input area), with shorter/narrower message rows for higher information density
2. **Timetable-style container** — Messages area wrapped in a `.board`-like panel (dark bg, border, border-radius) similar to the Timetable view's data table
3. **Metro interchange visualization** — When the agent uses cross-thread context, a vertical rail runs along the message list in the current thread's color, with branch lines from the side showing source threads (color + letter code). Backend data from `buildCrossThreadDigest` surfaced to the frontend.
4. **Tokyo Metro circle icons** — All letter-in-circle elements (SystemMap `.line-badge`, NetworkStatus `.host-badge`) updated to white inner circle with colored outer ring and bold inner text, matching authentic Tokyo Metro station markers

## Acceptance Criteria

### metro-interchange-ui.AC1: Compact LineView
- **metro-interchange-ui.AC1.1 Success:** Message bubbles use reduced padding (10px 14px) and margin (6px 0)
- **metro-interchange-ui.AC1.2 Success:** Header gap (10px), header margin-bottom (12px), and bottom-area padding (10px) are tighter than current values
- **metro-interchange-ui.AC1.3 Success:** LineView max-width is 42rem (narrower than current 48rem)
- **metro-interchange-ui.AC1.4 Success:** Textarea min-height is 44px with 8px 12px padding

### metro-interchange-ui.AC2: Timetable-Style Container
- **metro-interchange-ui.AC2.1 Success:** Messages area is wrapped in a panel with `background: rgba(10, 10, 20, 0.5)`, `border: 1px solid var(--bg-surface)`, `border-radius: 8px`
- **metro-interchange-ui.AC2.2 Success:** Header and input area remain outside the container panel
- **metro-interchange-ui.AC2.3 Success:** Messages scroll within the container while header and input stay fixed

### metro-interchange-ui.AC3: Metro Interchange Visualization
- **metro-interchange-ui.AC3.1 Success:** `buildCrossThreadDigest` returns `{ text: string; sources: CrossThreadSource[] }` with thread ID, title, color, messageCount, lastMessageAt per source
- **metro-interchange-ui.AC3.2 Success:** `ContextDebugInfo` includes `crossThreadSources` array when cross-thread context is present
- **metro-interchange-ui.AC3.3 Success:** Vertical rail in current thread's metro color is visible on every LineView conversation
- **metro-interchange-ui.AC3.4 Success:** Horizontal branch lines appear at turns with cross-thread sources, each colored in the source thread's metro color
- **metro-interchange-ui.AC3.5 Success:** Each branch terminates with a station marker showing the source thread's letter code (white inner circle + black text style)
- **metro-interchange-ui.AC3.6 Edge:** Rail displays with no branches when no cross-thread context exists (clean vertical line only)
- **metro-interchange-ui.AC3.7 Edge:** Old turns without `crossThreadSources` field render gracefully (no branches, no console errors)

### metro-interchange-ui.AC4: Tokyo Metro Circle Icons
- **metro-interchange-ui.AC4.1 Success:** SystemMap `.line-badge` shows filled colored circle + white inner circle (~65-70% diameter) + solid black bold letter
- **metro-interchange-ui.AC4.2 Success:** NetworkStatus `.host-badge` shows filled colored circle + white inner circle + solid black bold letter
- **metro-interchange-ui.AC4.3 Success:** White inner circle is proportional (~65-70% of outer diameter) across both components
- **metro-interchange-ui.AC4.4 Edge:** All 10 metro line colors render correctly with the new icon style (no color contrast issues)

## Glossary

- **Cross-thread context**: When the agent pulls information from previous conversations (other threads) to answer a question in the current conversation. The `buildCrossThreadDigest` function generates a summary of recent threads for the LLM.
- **Context debug pipeline**: The system that captures detailed metadata about what context the agent used for each turn, stored in `turns.context_debug` as JSON and exposed via WebSocket events and HTTP endpoints.
- **Metro color palette**: The set of 10 colors (indexed 0-9) used throughout the UI to visually distinguish threads and hosts, inspired by Tokyo Metro line colors. Defined in CSS variables `--line-0` through `--line-9`.
- **Interchange**: A metro station where multiple lines meet, allowing passengers to transfer between lines. In this design, the visual metaphor for turns where the agent used context from multiple threads.
- **Station marker**: The circular icon with a letter code that appears on Tokyo Metro maps to identify stations. In this design, marks the source thread at the end of each branch line.
- **Letter code**: A single alphabetic character (G, M, H, T, C, Y, Z, N, F, E) assigned to each thread based on its color index via the `lineCodes` array in SystemMap.
- **Board panel**: The dark, bordered container style used for data tables in the Timetable view, now applied to the messages area for visual consistency.
- **Volatile enrichment**: Dynamic context injected into each agent turn (memories, tasks, cross-thread digests) that reflects recent changes rather than static history. Part of Stage 5.5 in the context assembly pipeline.
- **WebSocket event subscription**: The pattern where Svelte components subscribe to real-time server events (like `context:debug`) via a shared `wsEvents` store to update the UI without page refresh.

## Architecture

Four coordinated changes to the Bound web UI, unified by the Tokyo Metro visual identity.

**Backend data enrichment.** `buildCrossThreadDigest()` in `packages/agent/src/summary-extraction.ts` currently returns a plain text string. It gains a structured return type: `{ text: string; sources: CrossThreadSource[] }`. The text continues into volatile context for the LLM unchanged. The sources array — containing thread ID, title, color index, message count, and last activity timestamp — is captured into a new optional `crossThreadSources` field on `ContextDebugInfo` in `packages/shared/src/types.ts`. This data flows through the existing `turns.context_debug` JSON column, the `GET /api/threads/:id/context-debug` endpoint, and WebSocket `context:debug` events without any schema migration or API changes.

**Interchange rail visualization.** A new `InterchangeRail.svelte` component renders as an SVG layer inside LineView's messages container. A vertical line in the current thread's metro color runs the full scrollable height. At message positions corresponding to turns with `crossThreadSources`, horizontal branch lines extend from the left — one per source thread, each in that thread's color, terminating in a small station marker with the source thread's letter code. The rail is always visible; branches appear only when cross-thread context exists.

**Compact layout and container.** LineView's messages area wraps in a Timetable-style `.board` panel (`rgba(10, 10, 20, 0.5)` background, 1px border, 8px radius). Padding, margins, and element sizes reduce across header, messages, and input area. Max-width narrows from 48rem to 42rem. Header and input area remain outside the container.

**Circle icon restyling.** All letter-in-circle elements adopt authentic Tokyo Metro signage style: filled colored outer circle, white inner circle at ~65-70% diameter, solid black bold letter. Applies to SystemMap `.line-badge` (CSS) and NetworkStatus `.host-badge` (SVG).

### Contract: CrossThreadSource

```typescript
interface CrossThreadSource {
  threadId: string;
  title: string;
  color: number;       // indexes into metro colors array
  messageCount: number;
  lastMessageAt: string;
}
```

Added as optional field on existing `ContextDebugInfo`:

```typescript
interface ContextDebugInfo {
  // ... existing fields unchanged ...
  crossThreadSources?: CrossThreadSource[];
}
```

### Contract: buildCrossThreadDigest return type

```typescript
// Before:
function buildCrossThreadDigest(db: Database, userId: string): string;

// After:
function buildCrossThreadDigest(db: Database, userId: string): {
  text: string;
  sources: CrossThreadSource[];
};
```

Callers that only use the text (the LLM context injection path) destructure `{ text }`. The context assembly path destructures both and attaches `sources` to the debug info.

## Existing Patterns

**Timetable `.board` container.** The messages container follows the exact pattern from `packages/web/src/client/views/Timetable.svelte`: `background: rgba(10, 10, 20, 0.5)`, `border: 1px solid var(--bg-surface)`, `border-radius: 8px`. This is the established "data panel" visual in the app.

**ContextDebugInfo JSON extension.** The `turns.context_debug` column stores `JSON.stringify(ContextDebugInfo)`. Adding optional fields to this type is the established extension pattern — `recordContextDebug()` in `packages/core/src/metrics-schema.ts` stringifies the whole object. Old rows without `crossThreadSources` parse cleanly (field is `undefined`). No schema migration needed.

**WebSocket event subscription.** `InterchangeRail.svelte` consumes the same `wsEvents` store and `context:debug` event type already used by `ContextDebugPanel.svelte`. The subscription pattern (filter by `thread_id`, dedup by `turn_id`) is copied directly from `packages/web/src/client/components/ContextDebugPanel.svelte`.

**Metro color palette.** Thread colors index into the `colors` array in `SystemMap.svelte` and the CSS variables `--line-0` through `--line-9` in `App.svelte`. The interchange rail and station markers use this same palette. `context-colors.ts` maps section names to line colors for the debug panel.

**Track station precedent.** SystemMap's `.track-station` elements already use white fill + colored border for small station dots along the track. The new `.line-badge` style (colored fill + white inner circle) is the "large station marker" complement to these small dots.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Backend — Cross-Thread Source Data

**Goal:** Surface structured cross-thread metadata through the existing context debug pipeline.

**Components:**
- `CrossThreadSource` type in `packages/shared/src/types.ts` — new interface with threadId, title, color, messageCount, lastMessageAt
- `ContextDebugInfo` extension in `packages/shared/src/types.ts` — add optional `crossThreadSources` field
- `buildCrossThreadDigest()` in `packages/agent/src/summary-extraction.ts` — change return type from `string` to `{ text: string; sources: CrossThreadSource[] }`, add `color` to SQL SELECT
- `assembleContext()` in `packages/agent/src/context-assembly.ts` — destructure new return type, attach sources to debug info
- Update all callers of `buildCrossThreadDigest` to handle new return type

**Dependencies:** None (first phase)

**Covers:** metro-interchange-ui.AC3.1, metro-interchange-ui.AC3.2, metro-interchange-ui.AC3.7

**Done when:** `buildCrossThreadDigest` returns structured sources, `ContextDebugInfo` carries `crossThreadSources` when cross-thread context exists, old turns without the field parse without errors, all existing tests pass with updated return type
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: Tokyo Metro Circle Icons

**Goal:** Update all letter-in-circle elements to authentic Tokyo Metro signage style.

**Components:**
- `.line-badge` in `packages/web/src/client/views/SystemMap.svelte` — add white inner circle element, change `.badge-code` to black bold text
- `.host-badge` SVG in `packages/web/src/client/views/NetworkStatus.svelte` — add white inner `<circle>`, change outer circle to filled, update `<text>` fill to black

**Dependencies:** None (independent of Phase 1)

**Covers:** metro-interchange-ui.AC4.1, metro-interchange-ui.AC4.2, metro-interchange-ui.AC4.3, metro-interchange-ui.AC4.4

**Done when:** SystemMap badges show colored fill + white inner circle + black bold letter, NetworkStatus host badges show the same pattern, all 10 metro line colors render correctly
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Compact LineView & Timetable Container

**Goal:** Increase information density and add visual containment to the thread view.

**Components:**
- `.messages` container in `packages/web/src/client/views/LineView.svelte` — wrap in `.board`-style panel, add left padding for future rail
- Layout CSS in `packages/web/src/client/views/LineView.svelte` — reduce padding, margins, gaps, max-width (48rem to 42rem)
- Message CSS in `packages/web/src/client/components/MessageBubble.svelte` — reduce padding (10px 14px), margin (6px), border-left width (2px)
- Input area CSS in `packages/web/src/client/views/LineView.svelte` — reduce textarea min-height (44px), padding (8px 12px)

**Dependencies:** None (independent of Phases 1-2, but placing after Phase 2 for visual coherence during development)

**Covers:** metro-interchange-ui.AC1.1, metro-interchange-ui.AC1.2, metro-interchange-ui.AC1.3, metro-interchange-ui.AC1.4, metro-interchange-ui.AC2.1, metro-interchange-ui.AC2.2, metro-interchange-ui.AC2.3

**Done when:** Messages area is wrapped in a board panel matching Timetable style, header and input stay outside the container, all spacing/sizing values match the compact spec, messages scroll within the container
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: Interchange Rail Visualization

**Goal:** Render a persistent metro rail with cross-thread interchange branches in the thread view.

**Components:**
- New `InterchangeRail.svelte` in `packages/web/src/client/components/` — SVG overlay component that renders vertical rail + horizontal branch lines + station markers
- LineView integration in `packages/web/src/client/views/LineView.svelte` — mount InterchangeRail inside the `.board` container, pass thread color, turns data, and message positions
- Context debug data consumption — subscribe to same `wsEvents` store for real-time turn updates, correlate turn timestamps with message DOM positions

**Dependencies:** Phase 1 (backend provides `crossThreadSources`), Phase 3 (container and left padding exist)

**Covers:** metro-interchange-ui.AC3.3, metro-interchange-ui.AC3.4, metro-interchange-ui.AC3.5, metro-interchange-ui.AC3.6

**Done when:** Vertical rail visible in thread's metro color on every conversation, branch lines appear at turns with cross-thread sources in source thread's color, each branch shows source thread's letter code in a station marker, rail displays cleanly with no branches when no cross-thread context exists
<!-- END_PHASE_4 -->

## Additional Considerations

**Backward compatibility.** Old `turns.context_debug` rows lack `crossThreadSources`. The field is optional on the type, and the frontend treats `undefined` as "no cross-thread context" — same as a turn that genuinely had none. No migration or backfill needed.

**Scroll synchronization.** The InterchangeRail SVG must stay synchronized with the messages scroll position. The component should observe the scroll container's height and scroll offset to position branches correctly. If messages are added dynamically (via WebSocket), the rail re-renders to accommodate new content.

**Current thread filtering.** `buildCrossThreadDigest` queries the 5 most recent threads for the user. The current thread should be excluded from the sources array to avoid a self-referential branch. The SQL already orders by `last_message_at DESC LIMIT 5` — add `AND id != ?` with the current thread ID.
