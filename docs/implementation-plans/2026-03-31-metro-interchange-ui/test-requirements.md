# Metro Interchange UI -- Test Requirements

Maps each acceptance criterion to automated tests (bun:test unit/integration) or documented human verification steps. Criteria that require visual rendering assessment are marked as human verification with justification.

---

## AC1: Compact LineView

### AC1.1: Message bubbles use reduced padding (10px 14px) and margin (6px 0)

**Verification type:** Human

**Justification:** This is a CSS-only change to `MessageBubble.svelte`. The project has no DOM rendering test infrastructure for Svelte components (existing component tests only verify module import, not rendered output). Computed style assertions require a browser environment.

**Human verification steps:**
1. Open any thread in the LineView.
2. Open browser DevTools, inspect a `.message` element inside `MessageBubble`.
3. Confirm `padding` is `10px 14px` and `margin` is `6px 0`.
4. Verify messages appear visually more compact than before the change.

---

### AC1.2: Header gap (10px), header margin-bottom (12px), bottom-area padding (10px) tighter than current

**Verification type:** Human

**Justification:** CSS value changes on `.header` and `.bottom-area` in `LineView.svelte`. Same DOM rendering limitation as AC1.1.

**Human verification steps:**
1. Open any thread in the LineView.
2. Inspect the `.header` element. Confirm `gap: 10px` and `margin-bottom: 12px`.
3. Inspect the `.bottom-area` element. Confirm `padding-top: 10px`.
4. Visually compare header and input spacing against the previous layout -- should be noticeably tighter.

---

### AC1.3: LineView max-width is 42rem

**Verification type:** Human

**Justification:** CSS value change on the `.line-view` container. No Svelte component rendering tests available.

**Human verification steps:**
1. Open any thread in the LineView with a wide browser window (> 42rem viewport).
2. Inspect the `.line-view` container element.
3. Confirm `max-width` computed value is `42rem` (672px at default font size).
4. Verify the thread view is visually narrower than before (was 48rem / 768px).

---

### AC1.4: Textarea min-height is 44px with 8px 12px padding

**Verification type:** Human

**Justification:** CSS value change on the `textarea` element in `LineView.svelte`. Same limitation.

**Human verification steps:**
1. Open any thread in the LineView.
2. Inspect the `textarea` element in the bottom input area.
3. Confirm `min-height: 44px` and `padding: 8px 12px`.
4. Type a short message -- textarea should feel compact but still usable for single-line input.

---

## AC2: Timetable-Style Container

### AC2.1: Messages area wrapped in panel with rgba(10,10,20,0.5) bg, 1px solid var(--bg-surface) border, 8px radius

**Verification type:** Human

**Justification:** Structural HTML change (wrapping `.messages` in `.board` div) plus CSS styling. No component rendering test infrastructure for verifying DOM structure of Svelte views.

**Human verification steps:**
1. Open any thread in the LineView.
2. Inspect the DOM structure. Confirm `.messages` is a child of a `.board` container.
3. On the `.board` element, verify:
   - `background: rgba(10, 10, 20, 0.5)`
   - `border: 1px solid var(--bg-surface)`
   - `border-radius: 8px`
4. Visually confirm the messages area has a dark panel appearance with rounded corners, matching the Timetable view's `.board` style.

---

### AC2.2: Header and input area remain outside container panel

**Verification type:** Human

**Justification:** DOM structure verification. The `.header` and `.bottom-area` must be siblings of `.board`, not children. Requires rendered DOM inspection.

**Human verification steps:**
1. Open any thread in the LineView.
2. Inspect the DOM tree. Confirm the structure is: `.header` -> `.board` (containing `.messages`) -> `.bottom-area` as siblings.
3. Visually confirm the header (thread title, controls) and input area (textarea, send button) are outside the dark panel.

---

### AC2.3: Messages scroll within container while header and input stay fixed

**Verification type:** Human

**Justification:** Scroll behavior is a runtime visual behavior that depends on CSS `overflow` and flex layout. Cannot be validated without a live browser.

**Human verification steps:**
1. Open a thread with enough messages to overflow the viewport.
2. Scroll through the messages area.
3. Confirm that only the messages inside the `.board` panel scroll.
4. Confirm the header and input area remain fixed/visible at their respective positions (top and bottom) during scroll.

---

## AC3: Metro Interchange Visualization

### AC3.1: buildCrossThreadDigest returns { text: string; sources: CrossThreadSource[] }

**Verification type:** Automated

**Test type:** Unit test (bun:test)

**Test file:** `packages/agent/src/__tests__/volatile-enrichment.test.ts`

**Implementation phase:** Phase 1, Task 3

**Tests to write/update:**

1. **Update existing test "includes thread summary when populated"** -- Change to destructure `{ text, sources }` from `buildCrossThreadDigest(db, userId)`. Assert `text` contains the summary string. Assert `sources` is an array with length 1. Assert the source has `threadId`, `title: "Memory Discussion"`, `color: 0`, `messageCount` (number), and `lastMessageAt` (string).

2. **Update existing test "still works when thread has no summary (null)"** -- Destructure `{ text, sources }`. Assert `text` contains "Untitled Thread". Assert `sources[0].title` is `"(untitled)"` (the fallback value per implementation). Assert `sources` has correct length.

3. **New test: "returns correct color values for each source thread"** -- Insert 3 threads with distinct `color` values (e.g., 0, 3, 7). Call `buildCrossThreadDigest`. Assert each entry in `sources` has the matching `color` value from its thread row.

4. **New test: "returns empty sources when no threads exist"** -- Call `buildCrossThreadDigest` for a user with no threads. Assert result is `{ text: "No recent activity.", sources: [] }`.

5. **New test: "excludes current thread when excludeThreadId is provided"** -- Create thread A (current) and thread B (other). Call `buildCrossThreadDigest(db, userId, threadA.id)`. Assert `sources` contains only thread B. Assert `sources` does not contain an entry with `threadId === threadA.id`.

6. **New test: "sources array matches thread count and order"** -- Insert 3 threads with different `last_message_at`. Call `buildCrossThreadDigest`. Assert `sources.length === 3`. Assert sources are ordered by `lastMessageAt` descending (matching the SQL `ORDER BY last_message_at DESC`).

---

### AC3.2: ContextDebugInfo includes crossThreadSources array when present

**Verification type:** Automated

**Test type:** Unit test (bun:test)

**Test file:** `packages/agent/src/__tests__/context-assembly.test.ts`

**Implementation phase:** Phase 1, Task 3

**Tests to write:**

1. **New test: "debug.crossThreadSources populated when cross-thread context exists"** -- Create a test user with 2+ threads (with messages in each). Call `assembleContext` for one thread. Assert `result.debug.crossThreadSources` is a non-empty array. Assert each entry has `threadId`, `title`, `color`, `messageCount`, `lastMessageAt`. Assert the current thread is NOT in the sources list.

2. **New test: "debug.crossThreadSources absent when no other threads exist"** -- Create a user with exactly one thread. Call `assembleContext`. Assert `result.debug.crossThreadSources` is `undefined` (no other threads means `sources` array is empty, so the spread expression `...(crossThreadSources ? { crossThreadSources } : {})` omits the field).

**Additionally verified by:** `packages/web/src/server/__tests__/threads-context-debug.test.ts` -- the existing HTTP route test for `GET /api/threads/:id/context-debug` should continue to pass, confirming the JSON column round-trips correctly with the new optional field.

---

### AC3.3: Vertical rail in current thread's metro color visible on every conversation

**Verification type:** Human

**Justification:** Visual rendering of an SVG element (`InterchangeRail.svelte`) inside the LineView. Requires a running application with rendered Svelte components. No component-level rendering tests exist for SVG output verification.

**Human verification steps:**
1. Open any thread (with or without cross-thread context).
2. Confirm a vertical line is visible on the left side of the messages panel (inside the `.board` container, in the 40px left padding area).
3. Confirm the line's color matches the thread's assigned metro line color (compare with the thread's badge in the SystemMap).
4. Open threads with different color indices -- verify the rail color changes accordingly.

---

### AC3.4: Horizontal branch lines at turns with cross-thread sources in source thread colors

**Verification type:** Human

**Justification:** SVG branch rendering depends on DOM position correlation between turns and messages, which requires a live browser with actual rendered content. Turn-to-message timestamp correlation logic cannot be meaningfully unit-tested without a real DOM.

**Human verification steps:**
1. Create a scenario where the agent uses cross-thread context: have multiple threads with messages, then ask a question in one thread that triggers `buildCrossThreadDigest` to return sources (the agent's turn will include cross-thread context).
2. After the agent responds, observe the rail visualization.
3. Confirm horizontal branch lines extend from the left toward the vertical rail at the vertical position of the assistant's response message.
4. Confirm each branch line is colored in the source thread's metro color (not the current thread's color).
5. If multiple source threads contributed, confirm multiple branch lines appear, stacked vertically with spacing.

---

### AC3.5: Each branch terminates with station marker showing source thread's letter code

**Verification type:** Human

**Justification:** SVG station marker rendering (small circle with letter code). Visual accuracy of the Metro signage style (colored outer circle, white inner circle, black letter) requires rendered output inspection.

**Human verification steps:**
1. Using the same scenario as AC3.4, locate a branch line with a station marker.
2. Confirm the marker is a small circle at the terminus of the branch line (left end, away from the rail).
3. Confirm the marker uses the Tokyo Metro signage style: colored outer fill matching the source thread's color, white inner circle, bold black letter.
4. Confirm the letter code matches the source thread's color index (G for 0, M for 1, H for 2, T for 3, C for 4, Y for 5, Z for 6, N for 7, F for 8, E for 9).

---

### AC3.6: Rail displays with no branches when no cross-thread context exists

**Verification type:** Human (primary) + Automated (supporting)

**Justification:** The visual rendering (rail with no branches) requires human verification. However, the underlying data condition (empty `crossThreadSources`) can be tested automatically.

**Automated supporting test:**

**Test file:** `packages/agent/src/__tests__/context-assembly.test.ts`

Already covered by AC3.2 test #2: when only one thread exists, `debug.crossThreadSources` is `undefined`, which the frontend treats as "no branches."

**Human verification steps:**
1. Create a new thread (first thread for the user, or the only active thread).
2. Send a message and wait for the agent response.
3. Confirm the vertical rail is visible (solid line in the thread's color).
4. Confirm no horizontal branch lines or station markers appear.
5. The rail should be a clean, uninterrupted vertical line.

---

### AC3.7: Old turns without crossThreadSources field render gracefully

**Verification type:** Automated (primary) + Human (supporting)

**Automated test:**

**Test type:** Unit test (bun:test)

**Test file:** `packages/agent/src/__tests__/volatile-enrichment.test.ts` (or `context-assembly.test.ts`)

**Implementation phase:** Phase 1, Task 3

**Test to write:**

1. **New test: "ContextDebugInfo without crossThreadSources parses cleanly"** -- Create a `ContextDebugInfo` JSON string without the `crossThreadSources` field (simulating data from old turns). Parse it with `JSON.parse`. Assert `parsed.crossThreadSources` is `undefined`. Assert no error is thrown. This validates the type's optional field backward compatibility.

**Human verification steps (supporting):**
1. In a deployment that has existing turns from before this feature, open a thread with historical turns.
2. Confirm the rail renders without errors (the vertical line appears, no branches at old turns).
3. Open the browser console -- confirm no JavaScript errors related to `crossThreadSources` being undefined.
4. If a new turn generates cross-thread context in the same thread, confirm branches appear only at the new turn, not at old turns.

---

## AC4: Tokyo Metro Circle Icons

### AC4.1: SystemMap .line-badge shows filled colored circle + white inner circle + bold black letter

**Verification type:** Human

**Justification:** CSS/HTML visual styling of `.line-badge` in `SystemMap.svelte`. Requires rendered DOM to verify the layered circle effect (outer colored fill, inner white circle via `.badge-inner`, black text via `.badge-code`). No Svelte component rendering test infrastructure.

**Human verification steps:**
1. Navigate to the System Map view (main page).
2. Locate the thread line badges (colored circles with letter codes, e.g., "G", "M", "H").
3. For each visible badge, confirm:
   - The outer circle is filled with the thread's metro color (not just a border/stroke).
   - A white inner circle is visible inside the colored outer circle.
   - The letter code is bold black text (not white text as before).
4. Inspect a `.line-badge` element in DevTools:
   - `.line-badge`: has `background` set to the metro color.
   - `.badge-inner`: `position: absolute`, `width: 24px`, `height: 24px`, `border-radius: 50%`, `background: #fff`.
   - `.badge-code`: `color: #000`, `font-weight: 700`, `position: relative`, `z-index: 1`.

---

### AC4.2: NetworkStatus .host-badge shows filled colored circle + white inner circle + bold black letter

**Verification type:** Human

**Justification:** SVG rendering changes in `NetworkStatus.svelte`. Requires a running multi-host deployment (or mock) to see host badges. Visual accuracy of SVG circles and text cannot be unit-tested without a rendering engine.

**Human verification steps:**
1. Navigate to the Network Status view (requires a multi-host deployment, or inspect the component in a single-host setup if host badges are visible).
2. Locate host badges (circles with letters like "A", "B" or "H" for hub).
3. For each badge, confirm:
   - The outer circle is filled with the host color (not hollow/stroke-only as before).
   - A white inner circle is visible.
   - The letter is bold black text (not colored text as before).
4. Inspect the SVG element in DevTools:
   - Outer `<circle>`: `fill` set to the metro color variable, no `stroke`.
   - Inner `<circle>`: `r="11"`, `fill="#fff"`.
   - `<text>`: `fill="#000"`, `font-weight="700"`.
5. For hub nodes: confirm the "H" badge has a subtle inner ring indicator (thin stroke, low opacity) inside the white area.

---

### AC4.3: White inner circle proportional (~65-70%) across both components

**Verification type:** Automated (supporting) + Human (primary)

**Automated supporting test:**

**Test type:** Unit test (bun:test)

**Test file:** `packages/web/src/client/lib/__tests__/metro-lines.test.ts` (new file)

**Implementation phase:** Phase 4, Task 1

**Tests to write:**

1. **New test: "getLineColor returns valid color for all indices 0-9"** -- Call `getLineColor(i)` for i in 0..9. Assert each returns a string starting with `#`. Assert all 10 values are distinct.

2. **New test: "getLineCode returns valid single-letter code for all indices 0-9"** -- Call `getLineCode(i)` for i in 0..9. Assert each returns a single uppercase letter. Assert the sequence is `["G","M","H","T","C","Y","Z","N","F","E"]`.

3. **New test: "getLineColor wraps around for indices >= 10"** -- Assert `getLineColor(10) === getLineColor(0)` and `getLineColor(11) === getLineColor(1)`.

While these tests do not directly verify the 65-70% proportion, they validate the shared constants that both badge implementations consume. The proportion itself is a CSS/SVG measurement.

**Human verification steps (primary):**
1. In the System Map view, inspect a `.line-badge`. Measure or compute the ratio:
   - `.badge-inner` width (24px) / `.line-badge` width (36px) = 66.7%. Confirm this is within the ~65-70% spec.
2. In the Network Status view, inspect a host badge SVG. Compute the ratio:
   - Inner `<circle>` radius (r=11) / outer `<circle>` radius (r=17) = 64.7%. Confirm this is within the ~65-70% spec.
   - Note: The diameter ratio is `22/34 = 64.7%`, which the implementation plan rounded to ~65%. Verify the visual result is acceptable.
3. Visually compare the two badge styles side by side -- the inner white circle should appear proportionally similar in both the CSS-based (SystemMap) and SVG-based (NetworkStatus) implementations.

---

### AC4.4: All 10 metro line colors render correctly

**Verification type:** Human (primary) + Automated (supporting)

**Automated supporting test:**

Already covered by the `metro-lines.test.ts` tests described under AC4.3 (test #1 validates all 10 colors are distinct and well-formed).

**Human verification steps (primary):**
1. Create or locate threads using all 10 color indices (0 through 9). The SystemMap assigns colors round-robin, so having 10+ threads will exercise all colors.
2. In the System Map view, verify each of the 10 line badges renders with the correct color:
   - Index 0: Ginza orange (#F39700)
   - Index 1: Marunouchi red (#E60012)
   - Index 2: Hibiya silver (#9CAEB7)
   - Index 3: Tozai sky blue (#009BBF)
   - Index 4: Chiyoda green (#009944)
   - Index 5: Yurakucho gold (#C1A470)
   - Index 6: Hanzomon purple (#8F76D6)
   - Index 7: Namboku emerald (#00AC9B)
   - Index 8: Fukutoshin brown (#9C5E31)
   - Index 9: Oedo ruby (#B6007A)
3. Pay special attention to lower-contrast colors against white (Hibiya silver #9CAEB7, Yurakucho gold #C1A470). The 6px outer ring (36px - 24px = 12px diameter difference, 6px per side) should be wide enough for these colors to remain clearly visible.
4. Verify no color appears washed out or invisible with the new filled-circle + white-inner styling.

---

## Summary Matrix

| AC | Criterion | Automated | Human | Test File(s) |
|----|-----------|-----------|-------|---------------|
| AC1.1 | Message bubble padding/margin | -- | Required | -- |
| AC1.2 | Header/input area spacing | -- | Required | -- |
| AC1.3 | LineView max-width 42rem | -- | Required | -- |
| AC1.4 | Textarea min-height/padding | -- | Required | -- |
| AC2.1 | Board panel styling | -- | Required | -- |
| AC2.2 | Header/input outside panel | -- | Required | -- |
| AC2.3 | Scroll containment | -- | Required | -- |
| AC3.1 | buildCrossThreadDigest return type | 6 unit tests | -- | `packages/agent/src/__tests__/volatile-enrichment.test.ts` |
| AC3.2 | ContextDebugInfo crossThreadSources | 2 unit tests | -- | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC3.3 | Vertical rail rendering | -- | Required | -- |
| AC3.4 | Horizontal branch lines | -- | Required | -- |
| AC3.5 | Station marker with letter code | -- | Required | -- |
| AC3.6 | Rail with no branches | 1 unit test (supporting) | Required | `packages/agent/src/__tests__/context-assembly.test.ts` |
| AC3.7 | Old turns backward compat | 1 unit test | Supporting | `packages/agent/src/__tests__/volatile-enrichment.test.ts` |
| AC4.1 | SystemMap .line-badge style | -- | Required | -- |
| AC4.2 | NetworkStatus .host-badge style | -- | Required | -- |
| AC4.3 | Inner circle proportion | 3 unit tests (supporting) | Required | `packages/web/src/client/lib/__tests__/metro-lines.test.ts` |
| AC4.4 | All 10 colors render | 1 unit test (supporting) | Required | `packages/web/src/client/lib/__tests__/metro-lines.test.ts` |

## Automated Test Count

| Test File | New Tests | Updated Tests | Total |
|-----------|-----------|---------------|-------|
| `packages/agent/src/__tests__/volatile-enrichment.test.ts` | 5 | 2 | 7 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | 2 | 0 | 2 |
| `packages/web/src/client/lib/__tests__/metro-lines.test.ts` (new) | 3 | 0 | 3 |
| **Total** | **10** | **2** | **12** |

## Rationale for Human Verification Scope

All AC1, AC2, AC3.3-AC3.6, AC4.1, AC4.2, and AC4.4 criteria require human verification because they involve:

1. **CSS styling values** applied to Svelte components that only render in a browser. The project uses `bun:test` which runs in Bun's JavaScript runtime without a DOM. Existing Svelte "component tests" (`packages/web/src/client/__tests__/components.test.ts`) only verify that modules import without error -- they do not mount or render components.

2. **SVG visual output** that depends on browser rendering of circles, lines, and text positioning. SVG path correctness and visual appearance cannot be validated by asserting on source code strings.

3. **Layout behavior** (scroll containment, fixed positioning) that depends on CSS flexbox layout computed by a browser engine.

The project does have Playwright e2e tests (`e2e/*.spec.ts`) which could theoretically automate some of these checks via `page.evaluate()` to read computed styles. However, the existing e2e tests are lightweight smoke tests (page loads, basic navigation) and do not assert on specific CSS values. Extending the e2e suite for computed style assertions is a possible future improvement but is not part of this implementation scope.

The automated tests focus on the areas where meaningful assertions are possible without a browser: backend data contracts (AC3.1, AC3.2, AC3.7) and shared utility functions (AC4.3, AC4.4 supporting tests).
