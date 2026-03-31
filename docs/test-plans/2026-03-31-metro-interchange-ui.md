# Metro Interchange UI — Human Test Plan

**Generated:** 2026-03-31
**Implementation plan:** `docs/implementation-plans/2026-03-31-metro-interchange-ui/`

## Prerequisites

- Bound running locally: `bun packages/cli/src/bound.ts start` from the project root (or `--config-dir` pointing to a valid config directory)
- Web UI accessible at `http://localhost:3000` (default)
- At least one LLM backend configured (needed for agent responses that generate cross-thread context)
- All automated tests passing:
  ```bash
  bun test packages/agent/src/__tests__/volatile-enrichment.test.ts
  bun test packages/agent/src/__tests__/context-assembly.test.ts --test-name-pattern "metro-interchange-ui"
  bun test packages/web/src/client/lib/__tests__/metro-lines.test.ts
  ```

## Phase 1: Compact LineView (AC1.1-AC1.4)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Navigate to `http://localhost:3000`. Click on any existing thread (or create one). | Thread opens in the LineView. |
| 1.2 | Open browser DevTools. Inspect a `.message` element inside `MessageBubble`. | `padding` is `10px 14px`. `margin` is `6px 0`. |
| 1.3 | Inspect the `.header` element at the top of the LineView. | `gap` is `10px`. `margin-bottom` is `12px`. |
| 1.4 | Inspect the `.bottom-area` element at the bottom of the LineView. | `padding-top` is `10px`. |
| 1.5 | Inspect the `.line-view` container element. | `max-width` computed value is `672px` (42rem at 16px base font size). |
| 1.6 | Resize the browser window to be wider than 672px. | The thread view does not expand beyond 672px width. |
| 1.7 | Inspect the `textarea` element in the bottom input area. | `min-height` is `44px`. `padding` is `8px 12px`. |
| 1.8 | Type a short single-line message in the textarea. | The textarea appears compact but comfortably fits a single line of text. |

## Phase 2: Timetable-Style Container (AC2.1-AC2.3)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | In the LineView, inspect the DOM tree around the messages list. | `.messages` is a direct child of a `.board` container div. |
| 2.2 | Inspect the `.board` element's computed styles. | `background: rgba(10, 10, 20, 0.5)`. `border: 1px solid` with the value of `var(--bg-surface)`. `border-radius: 8px`. |
| 2.3 | Verify the DOM hierarchy: `.header`, `.board` (containing `.messages`), `.bottom-area` are siblings. | The header and bottom-area are NOT children of `.board`. They are at the same level. |
| 2.4 | Visually confirm the messages area appears as a dark, semi-transparent panel with rounded corners. | The panel matches the Timetable view's `.board` style. |
| 2.5 | Open or create a thread with many messages (at least 20) so they overflow the visible area. | Messages overflow the panel height. |
| 2.6 | Scroll through the messages area using mouse wheel or trackpad. | Only the messages inside the `.board` panel scroll. The `.header` and `.bottom-area` remain fixed. |

## Phase 3: Metro Interchange Visualization (AC3.3-AC3.6)

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Open any thread in the LineView. Look at the left side of the messages panel. | A vertical line (rail) is visible on the left side of the `.board` container, within the left padding area. |
| 3.2 | Note the rail's color. Navigate to the System Map view and find the same thread's badge. | The rail color matches the thread's assigned metro line color in the System Map. |
| 3.3 | Open threads with different color indices (create multiple threads if needed). | Each thread's rail uses the correct metro line color. Different threads show different colored rails. |
| 3.4 | Create a scenario to trigger cross-thread context: Create Thread A and send a few messages. Create Thread B and send a few messages. Return to Thread A (or create Thread C) and ask a question that would naturally draw on context from the other threads. Wait for the agent to respond. | After the agent responds, cross-thread context is generated. |
| 3.5 | After receiving the agent response from step 3.4, observe the rail visualization at the assistant's response message. | Horizontal branch lines extend from the left toward the vertical rail. Each branch line is colored in the source thread's metro color (not the current thread's color). |
| 3.6 | If multiple source threads contributed context, count the branch lines. | Multiple branch lines appear, one per source thread, stacked vertically with spacing. |
| 3.7 | Look at the terminus (left end) of each branch line. | Each branch terminates with a station marker: colored outer circle, white inner circle, bold black letter. |
| 3.8 | Read the letter code on each station marker. | The letter matches the source thread's color index: G(0), M(1), H(2), T(3), C(4), Y(5), Z(6), N(7), F(8), E(9). |
| 3.9 | Create a brand new thread. Send a message and receive a response. | Vertical rail visible, no horizontal branch lines — clean uninterrupted vertical line. |
| 3.10 | If the deployment has historical turns from before this feature, open a thread with old turns. | The rail renders without errors. No branch lines at old turns. No console errors. |
| 3.11 | In the same thread with old turns, send a new message that triggers cross-thread context. | Branches appear only at the new turn, not at old turns. |

## Phase 4: Tokyo Metro Circle Icons (AC4.1-AC4.4)

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Navigate to the System Map view. Locate thread line badges. | Each badge shows filled colored outer circle, white inner circle, bold black letter code. |
| 4.2 | Inspect a `.line-badge` element in DevTools. | `.badge-inner`: `width: 24px`, `height: 24px`, `background: #fff`. `.badge-code`: `color: #000`, `font-weight: 700`. |
| 4.3 | Measure the badge proportion: `.badge-inner` width (24px) / `.line-badge` width (36px). | Ratio is ~67%, within the 65-70% specification. |
| 4.4 | Navigate to the Network Status view (multi-host deployment or inspect SVG). | Host badges show filled colored outer circle, white inner circle, bold black letter. |
| 4.5 | Inspect a host badge SVG element in DevTools. | Outer `<circle>`: filled, no stroke. Inner `<circle>`: `r="11"`, `fill="#fff"`. `<text>`: `fill="#000"`, `font-weight="700"`. |
| 4.6 | Measure SVG badge proportion: inner r=11 / outer r=17. | Ratio is ~65%, within specification. |
| 4.7 | For hub nodes in Network Status, inspect the "H" badge. | Subtle inner ring indicator (thin stroke, low opacity) inside the white area. |
| 4.8 | Create or locate threads covering all 10 color indices (0-9). View the System Map. | Each renders with the correct color: Ginza orange, Marunouchi red, Hibiya silver, Tozai sky blue, Chiyoda green, Yurakucho gold, Hanzomon purple, Namboku emerald, Fukutoshin brown, Oedo ruby. |
| 4.9 | Pay special attention to Hibiya silver (#9CAEB7) and Yurakucho gold (#C1A470). | Lower-contrast colors remain clearly visible with adequate outer ring width. |
| 4.10 | Visually compare SystemMap badges and NetworkStatus badges side by side. | Inner white circle proportion appears visually similar between CSS and SVG implementations. |

## End-to-End: Cross-Thread Context Visualization

| Step | Action | Expected |
|------|--------|----------|
| E2E.1 | Start the application. Navigate to `http://localhost:3000`. | System Map loads. |
| E2E.2 | Create Thread A. Send: "Remember that my favorite programming language is Rust." Wait for response. | Agent responds. Thread A's badge appears in System Map with metro style. |
| E2E.3 | Note Thread A's color and letter code from the System Map badge. | Badge uses filled-circle + white-inner + black-letter style. |
| E2E.4 | Create Thread B. Send: "What do you know about my preferences from our other conversations?" Wait for response. | Agent responds, referencing Rust preference from Thread A via cross-thread context. |
| E2E.5 | In Thread B's LineView, observe the rail at the agent's response. | Vertical rail in Thread B's color. Branch line(s) in Thread A's color with station marker showing Thread A's letter code. |
| E2E.6 | Open DevTools Network tab, fetch `http://localhost:3000/api/threads/{threadB-id}/context-debug`. | JSON includes `crossThreadSources` array with Thread A's threadId, title, color, messageCount, lastMessageAt. |
| E2E.7 | Return to System Map. | Both threads listed with correct metro colors and letter codes. |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1: Message bubble padding/margin | -- | 1.1-1.2 |
| AC1.2: Header/input area spacing | -- | 1.3-1.4 |
| AC1.3: LineView max-width 42rem | -- | 1.5-1.6 |
| AC1.4: Textarea min-height/padding | -- | 1.7-1.8 |
| AC2.1: Board panel styling | -- | 2.1-2.4 |
| AC2.2: Header/input outside panel | -- | 2.3 |
| AC2.3: Scroll containment | -- | 2.5-2.6 |
| AC3.1: buildCrossThreadDigest structured return | `volatile-enrichment.test.ts` (6 tests) | -- |
| AC3.2: ContextDebugInfo crossThreadSources | `context-assembly.test.ts` (2 tests) | -- |
| AC3.3: Vertical rail rendering | -- | 3.1-3.3 |
| AC3.4: Horizontal branch lines | -- | 3.4-3.6 |
| AC3.5: Station marker with letter code | -- | 3.7-3.8 |
| AC3.6: Rail with no branches | `context-assembly.test.ts` (AC3.2 #2, supporting) | 3.9 |
| AC3.7: Old turns backward compat | `context-assembly.test.ts` (primary) | 3.10-3.11 (supporting) |
| AC4.1: SystemMap .line-badge style | -- | 4.1-4.3 |
| AC4.2: NetworkStatus .host-badge style | -- | 4.4-4.7 |
| AC4.3: Inner circle proportion | `metro-lines.test.ts` (supporting) | 4.3, 4.6, 4.10 |
| AC4.4: All 10 colors render | `metro-lines.test.ts` (supporting) | 4.8-4.9 |
