# Human Test Plan: Web Markdown Rendering

**Feature:** Web markdown rendering in MessageBubble
**Implementation plan:** `docs/implementation-plans/2026-03-29-web-md-render/`
**Coverage result:** PASS — all 21 acceptance criteria covered by automated tests

---

## Prerequisites

- The `web-md-render` branch is checked out and dependencies are installed (`bun install`)
- All automated tests pass:
  - `bun test packages/web/src/client/lib/__tests__/markdown.test.ts` (24 unit tests)
  - `bun run test:e2e -- --grep "Markdown rendering"` (11 E2E tests)
- The web server is running locally: `bun packages/cli/src/bound.ts start`
- A modern browser (Chrome/Firefox) is open to the web UI (default: `http://localhost:3000`)

---

## Phase 1: Heading Hierarchy Visual Quality (AC4.1)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Open the web UI in the browser. Create or navigate to a thread. | Thread view is displayed. |
| 2 | Send a message that triggers an assistant response containing all heading levels mixed with body text. If the LLM does not produce this naturally, use the API to inject a message with content: `# Heading 1\n\n## Heading 2\n\n### Heading 3\n\nBody text paragraph with **bold** and *italic* for context.` | The assistant message bubble appears with rendered markdown. |
| 3 | Visually inspect the heading sizes relative to each other and the body text. | H1 is the largest but noticeably smaller than browser-default H1. H2 is smaller than H1 but still reads as a heading. H3 is approximately body-text size but bolder. All headings form a clear descending hierarchy. None of the headings overpower the message bubble layout or look like page-level titles. |
| 4 | Compare with a user message containing the same markdown content. | User messages also render with the same toned-down heading sizes. |

---

## Phase 2: Table Horizontal Scroll Visual Quality (AC4.2)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Create or navigate to a thread. Inject an assistant message containing a wide markdown table: at least 8 columns with moderately long cell content. Example: `\| Name \| Email \| Department \| Location \| Phone \| Manager \| Start Date \| Status \|\n\| --- \| --- \| --- \| --- \| --- \| --- \| --- \| --- \|\n\| Alice Johnson \| alice@example.com \| Engineering \| San Francisco \| 555-0101 \| Bob Smith \| 2024-01-15 \| Active \|` (repeat rows). | The message bubble renders the table. |
| 2 | Observe whether the table overflows the message bubble horizontally. | The table is contained within the message bubble. No horizontal scrollbar appears on the page itself. |
| 3 | If the table is wider than the bubble, check for a horizontal scrollbar inside the `.table-wrap` container. | A horizontal scrollbar appears within the table wrapper, not on the outer page. Scrolling is smooth. |
| 4 | Scroll the table left and right. Inspect whether cell content is legible without text wrapping within cells. | Cell content stays on a single line (no wrapping), and all columns are readable when scrolled into view. |
| 5 | Resize the browser window to a narrow width (e.g., 400px). | The scrollbar becomes more prominent as the table overflows more, but the bubble itself does not break layout. |

---

## Phase 3: Inline Code Visual Distinction (AC4.3)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a thread with an assistant message containing inline code mixed with prose. Example content: `You can use \`Array.from()\` or \`Object.keys()\` to iterate. The \`map()\` method is also useful.` | The message renders with inline code spans interspersed in prose. |
| 2 | Visually inspect the inline code spans against surrounding text. | Each code span is immediately distinguishable: it has a visible background color (darker surface tone), monospace font (IBM Plex Mono or similar), and subtle padding/border-radius that makes it look like a "pill." |
| 3 | Compare with a fenced code block in the same message to ensure inline code and block code are visually distinct. | Inline code appears as small highlighted spans within prose. Fenced code blocks are full-width with their own background, syntax highlighting, and more padding. The two styles are clearly different. |

---

## Phase 4: Thinking Block Visual Quality (AC4.4)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Navigate to a thread with an assistant message containing a thinking block. Content: `<thinking>## My Reasoning\n\nI need to consider:\n- Option A\n- Option B\n\nLet me think through this carefully.</thinking>\n\nHere is my answer.` | The message renders with a collapsed `<details>` element and body text below it. |
| 2 | Inspect the collapsed state. | A disclosure triangle is visible with the text "Thinking..." next to it. The "Thinking..." text is in a muted/secondary color. A purple-tinted left border (Hanzomon purple, ~rgba(143,118,214,0.75)) runs along the left side of the block. |
| 3 | Click on "Thinking..." to expand the block. | The block expands to reveal rendered markdown inside: an H2 heading, a paragraph, and a bullet list. The left border continues along the full expanded height. |
| 4 | Click again to collapse. | The block collapses back to just "Thinking..." with the disclosure triangle. The transition is not jarring. |
| 5 | Compare the purple border color to other purple elements in the UI (e.g., tool_call borders, which use the same Hanzomon purple). | The thinking block border is the same hue but at reduced opacity (~0.75), making it subtler than solid purple accents elsewhere. |

---

## Phase 5: Plain-Text Fallback Timing (AC2.3)

| Step | Action | Expected |
|------|--------|----------|
| 1 | Clear browser cache and storage (or open an incognito/private window) to ensure Shiki has not been initialized. | Fresh session with no cached Shiki highlighter. |
| 2 | Navigate to the web UI and open or create a thread. | Thread view loads. |
| 3 | Send a message that triggers an assistant response containing markdown with a fenced code block (this forces Shiki initialization). Watch the message bubble closely as it appears. | The message bubble appears immediately with visible text content. There is NO moment where the bubble is empty or blank. |
| 4 | Observe the transition from plain text to rendered markdown. | The transition should be smooth. The plain text (fallback) is shown first, then replaced by rendered HTML once `renderMarkdown` resolves. There should not be a disorienting flash or layout jump. If Shiki takes time to load, the code block area may transition from plain text to syntax-highlighted text, but the content is never absent. |
| 5 | Navigate away from the thread and back. | On return, rendering should be near-instant since the Shiki highlighter is now cached in memory. No flash should be visible at all. |

---

## End-to-End: Full Message Lifecycle

**Purpose:** Validates that a single thread can contain all message roles and markdown features simultaneously without interference between them.

**Steps:**
1. Start the web server with `bun packages/cli/src/bound.ts start`.
2. Open the web UI at `http://localhost:3000`.
3. Create a new thread.
4. Using the API or by interacting with the agent, generate a thread that contains messages with all roles: `user`, `assistant`, `tool_call`, `tool_result`, `alert`, `system`.
5. Ensure the assistant message contains: headings (`##`), bold text (`**bold**`), a bullet list, inline code (`` `code` ``), a fenced code block with a language tag (` ```javascript `), a table, and a `<thinking>` block.
6. Verify: the assistant and user messages show rendered markdown with `.md-content` class. The tool_call message shows a collapsible header with the tool name and a `<pre>` block when expanded. The tool_result message shows a `<pre>` block. The alert and system messages show raw text with no markdown rendering.
7. Verify: the fenced code block in the assistant message has syntax highlighting (colored tokens via inline styles). The table is scrollable. The thinking block is collapsed and expandable.
8. Open browser DevTools, inspect a rendered assistant message. Confirm there are no `<script>` tags, no `onclick` attributes, and that `style="color:..."` attributes are present on Shiki spans.

---

## End-to-End: Streaming Update Consistency

**Purpose:** Validates that markdown re-renders correctly as streaming content arrives.

**Steps:**
1. Send a message that triggers a long assistant response (one that streams in over several seconds).
2. Watch the message bubble as chunks arrive.
3. Verify: the content grows incrementally. Partially received markdown (e.g., an unclosed code block) does not cause the bubble to become blank or show raw HTML. Once the response completes, the final rendered state includes all markdown features correctly.

---

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC4.1 (visual quality) | Computed font-size assertion cannot judge whether headings look proportionally right in context alongside body text and the message bubble layout. | Phase 1 above (all 4 steps). |
| AC4.2 (visual quality) | `overflow-x: auto` assertion cannot confirm scroll behavior feels smooth, scrollbar appears when expected, or column content is legible. | Phase 2 above (all 5 steps). |
| AC4.3 (visual quality) | Monospace font-family and non-transparent background assertion cannot judge whether inline code is visually distinct against surrounding prose — contrast, padding, and border-radius are subjective. | Phase 3 above (all 3 steps). |
| AC4.4 (visual quality) | Non-zero border-left-width assertion cannot judge the color, opacity, or visual relationship to the Hanzomon purple design token. | Phase 4 above (all 5 steps). |
| AC2.3 (timing quality) | Non-blank content assertion cannot judge whether there is a visible flash or jarring transition between plain-text fallback and rendered markdown on cold start. | Phase 5 above (all 5 steps). |

---

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| web-md-render.AC1.1 | E2E: `assistant message with markdown renders formatted HTML (AC1.1)` | — |
| web-md-render.AC1.2 | E2E: `user message with markdown renders formatted HTML (AC1.2)` | — |
| web-md-render.AC1.3 | E2E: `tool_call message stays in pre block, not rendered as markdown (AC1.3)` | — |
| web-md-render.AC1.4 | E2E: `tool_result message is not markdown-rendered (AC1.4)` | — |
| web-md-render.AC1.5 | E2E: `alert message is not markdown-rendered (AC1.5)` | — |
| web-md-render.AC1.6 | E2E: `system message is not markdown-rendered (AC1.6)` | — |
| web-md-render.AC2.1 | Unit: `renders fenced code with a known language using Shiki inline styles (AC2.1)` | — |
| web-md-render.AC2.2 | Unit: `renders fenced code with no language without Shiki color styles (AC2.2)` | — |
| web-md-render.AC2.3 | E2E: `message content is never blank/empty while rendering (AC2.3)` | Phase 5 |
| web-md-render.AC3.1 | Unit: `renders a single thinking block as a collapsed <details> element (AC3.1)` | — |
| web-md-render.AC3.2 | Unit: `renders markdown inside a thinking block (AC3.2)` | — |
| web-md-render.AC3.3 | Unit: `renders multiple thinking blocks as separate <details> elements (AC3.3)` | — |
| web-md-render.AC3.4 | Unit: `renders a message with no thinking blocks with no <details> elements (AC3.4)` | — |
| web-md-render.AC4.1 | E2E: `h2 heading in markdown renders at toned-down font-size (AC4.1)` | Phase 1 |
| web-md-render.AC4.2 | E2E: `markdown table has overflow-x auto on .table-wrap (AC4.2)` | Phase 2 |
| web-md-render.AC4.3 | E2E: `inline code has monospace font and visible background (AC4.3)` | Phase 3 |
| web-md-render.AC4.4 | E2E: `thinking block has a visible left border (AC4.4)` | Phase 4 |
| web-md-render.AC5.1 | Unit: `strips <script> tags from output (AC5.1)` | — |
| web-md-render.AC5.2 | Unit: `strips onclick attributes from output (AC5.2)` | — |
| web-md-render.AC5.3 | Unit: `preserves Shiki inline style attributes after DOMPurify (AC5.3)` | — |
| web-md-render.AC5.4 | Unit: `preserves <details> and <summary> tags from thinking blocks after DOMPurify (AC5.4)` | — |
