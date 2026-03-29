# Web Markdown Rendering Design

## Summary

This design adds client-side markdown rendering to the web UI's `MessageBubble` component. Currently all messages are displayed as plain text; the goal is for `assistant` and `user` messages to instead be parsed as markdown and rendered as formatted HTML, with syntax-highlighted fenced code blocks and collapsed disclosure widgets for `<thinking>` content emitted by reasoning-capable models. Messages for other roles (`tool_call`, `tool_result`, `alert`, `system`) are left unchanged.

The approach is entirely frontend — no backend changes are needed because messages remain stored as plain text strings in the database. A new `markdown.ts` module encapsulates the full rendering pipeline: the raw string is first split on `<thinking>` tags, each segment is converted to HTML by `marked`, fenced code blocks are syntax-highlighted by a lazily initialized Shiki singleton, the segments are reassembled, and the combined HTML is sanitized by DOMPurify before being injected into the component via Svelte's `{@html}`. Styling is handled through scoped CSS using the existing Tokyo Metro design-system variables.

## Definition of Done

- `MessageBubble.svelte` renders `assistant` and `user` role messages as markdown (via `marked` → `DOMPurify` → Svelte's `{@html}`)
- `tool_call`, `tool_result`, `alert`, and `system` messages keep their current plain-text / `<pre>` rendering unchanged
- Fenced code blocks receive syntax highlighting (Shiki with tokyo-night theme)
- `<thinking>...</thinking>` blocks in assistant messages are extracted and rendered as collapsed `<details>/<summary>` elements with markdown-rendered content inside
- Markdown elements (headings, lists, tables, blockquotes, inline code, fenced code blocks) are styled to fit the existing Tokyo Metro aesthetic
- No backend changes required

## Acceptance Criteria

### web-md-render.AC1: Assistant and user messages render as markdown
- **web-md-render.AC1.1 Success:** Assistant message containing `## Header`, `**bold**`, and `- list item` renders as formatted HTML (`<h2>`, `<strong>`, `<li>`)
- **web-md-render.AC1.2 Success:** User message containing markdown syntax renders as formatted HTML
- **web-md-render.AC1.3 Failure:** `tool_call` message is not markdown-rendered (stays in existing `<pre>` format)
- **web-md-render.AC1.4 Failure:** `tool_result` message is not markdown-rendered
- **web-md-render.AC1.5 Failure:** `alert` message is not markdown-rendered
- **web-md-render.AC1.6 Failure:** `system` message is not markdown-rendered

### web-md-render.AC2: Fenced code blocks receive syntax highlighting
- **web-md-render.AC2.1 Success:** Fenced code block with a recognized language (e.g. ` ```javascript `) renders with Shiki inline `style` color attributes
- **web-md-render.AC2.2 Success:** Fenced code block with no language tag renders as a styled code block without Shiki color attributes
- **web-md-render.AC2.3 Edge:** Before the Shiki singleton initializes, the component displays plain text content (not a blank/empty element)

### web-md-render.AC3: `<thinking>` blocks render as collapsed disclosure widgets
- **web-md-render.AC3.1 Success:** Message with a `<thinking>...</thinking>` block renders a `<details>` element with `<summary>Thinking...</summary>`, collapsed by default
- **web-md-render.AC3.2 Success:** Content inside a thinking block is markdown-rendered (headers, code, lists work inside)
- **web-md-render.AC3.3 Success:** Message with multiple `<thinking>` blocks renders each as a separate `<details>` element
- **web-md-render.AC3.4 Edge:** Message with no `<thinking>` blocks renders with no `<details>` elements in output

### web-md-render.AC4: Markdown elements match Tokyo Metro aesthetic
- **web-md-render.AC4.1 Success:** `<h1>`, `<h2>`, `<h3>` headings render at toned-down sizes (not full browser default heading sizes)
- **web-md-render.AC4.2 Success:** A markdown table wider than its container scrolls horizontally rather than overflowing or text-wrapping
- **web-md-render.AC4.3 Success:** Inline code renders in a monospace font with a visually distinct background
- **web-md-render.AC4.4 Success:** Thinking block has a visible left border at reduced opacity

### web-md-render.AC5: XSS safety and DOMPurify correctness
- **web-md-render.AC5.1 Security:** `<script>` tag in message content is stripped from rendered output
- **web-md-render.AC5.2 Security:** `onclick` attribute in message content is stripped from rendered output
- **web-md-render.AC5.3 Security:** Shiki inline `style="color:..."` attributes on code tokens survive DOMPurify sanitization
- **web-md-render.AC5.4 Security:** `<details>` and `<summary>` tags generated from thinking blocks survive DOMPurify sanitization

## Glossary

- **`marked`**: A JavaScript library that parses a Markdown string and returns an HTML string. Used here as the core Markdown-to-HTML conversion step.
- **`marked-highlight`**: A `marked` extension that intercepts fenced code block rendering and delegates syntax highlighting to an external highlighter (in this case, Shiki).
- **Shiki**: A syntax highlighter that produces HTML with inline `style` color attributes. Loads grammar and theme bundles asynchronously; this design caches the initialized instance as a module-level singleton so the cost is paid only once.
- **DOMPurify**: A DOM-based HTML sanitizer that strips potentially dangerous markup (scripts, event handler attributes, `javascript:` URLs) from an HTML string before it is injected into the DOM.
- **`{@html}`**: A Svelte template directive that injects a pre-built HTML string directly into the DOM, bypassing Svelte's normal auto-escaping. Requires explicit sanitization of the string before use.
- **`$state` / `$effect`**: Svelte 5 rune APIs. `$state` declares reactive state; `$effect` runs a side-effect callback whenever its reactive dependencies change. Used here to re-render markdown whenever message content updates.
- **Lazy singleton**: A module-level variable that holds the result of an expensive initialization (here, `createHighlighter()`) so it runs at most once. Subsequent calls await the same cached `Promise`.
- **`<thinking>` block**: A convention used by some LLM providers (e.g. extended thinking in Claude) where the model wraps its internal reasoning in `<thinking>...</thinking>` XML tags before giving its final response.
- **`<details>` / `<summary>`**: Native HTML elements that implement a browser-built disclosure widget — the `<summary>` is always visible and acts as a toggle; the remaining content inside `<details>` is hidden until the user clicks to expand.
- **Tokyo Metro aesthetic**: The visual design system used across the Bound web UI, built around CSS variables named after Tokyo Metro line colors (`--line-*`) and neutral tones (`--text-*`, `--bg-*`).
- **`splitOnThinkingBlocks`**: A function defined in `markdown.ts` that splits a raw message string on `<thinking>...</thinking>` occurrences, returning an ordered array of plain-text segments and thinking segments so each can be rendered appropriately.
- **`ADD_ATTR: ['style']`**: A DOMPurify configuration option that whitelists specific HTML attributes that would otherwise be stripped during sanitization. Required here to preserve Shiki's inline `style="color:..."` token coloring.
- **`:global(...)` selector**: A Svelte CSS modifier that makes a style rule apply to elements outside the component's shadow scope. Used to style markdown-generated HTML that Svelte's scoped class system cannot reach directly.
- **`custom renderer`**: A `marked` API that lets callers override how specific Markdown elements (here, tables) are converted to HTML, in order to wrap them in a container div for horizontal scrolling.

---

## Architecture

Client-side only. All markdown processing happens in the browser; messages remain stored as plain text strings in the database.

### Rendering Pipeline

```
content (markdown string, may contain <thinking> blocks)
  → splitOnThinkingBlocks(content)
      → [TextSegment | ThinkingSegment, ...]
  → for each segment:
      TextSegment:    marked.parse(text) → HTML
      ThinkingSegment:
          <details class="thinking-block">
            <summary>Thinking...</summary>
            marked.parse(innerText) → HTML
          </details>
  → join all segment HTML
  → DOMPurify.sanitize(combined, {
        ADD_ATTR: ['style'],           // Shiki inline color styles
        ADD_TAGS: ['details', 'summary'],
    })
  → safe HTML string → Svelte {@html}
```

### New Module: `packages/web/src/client/markdown.ts`

Single public export:

```typescript
export async function renderMarkdown(content: string): Promise<string>
```

Internal responsibilities:
- **Lazy Shiki singleton** — `createHighlighter()` called once on first use; the resulting `Promise<Highlighter>` is cached at module level so grammar bundles load only once across all `MessageBubble` instances
- **`marked` instance** — configured once at module init with the `markedHighlight` extension wired to the Shiki singleton; custom `renderer.table` wraps every `<table>` in `<div class="table-wrap">` to enable horizontal scroll
- **`splitOnThinkingBlocks`** — splits on `/<thinking>([\s\S]*?)<\/thinking>/gi`; returns ordered array of text/thinking segments
- **`DOMPurify`** — sanitizes the joined HTML with `ADD_ATTR: ['style']` and `ADD_TAGS: ['details', 'summary']`

**Shiki config:**
- Theme: `tokyo-night`
- Preloaded languages: `javascript`, `typescript`, `sql`, `python`, `bash`, `json`, `yaml`, `html`, `css`, `plaintext`

### `MessageBubble.svelte` Changes

Roles `assistant` and `user` gain reactive async rendering:

```typescript
// Contract — not implementation
let rendered: string = $state('');

$effect(() => {
  if (role === 'assistant' || role === 'user') {
    renderMarkdown(content).then(html => { rendered = html; });
  }
});
```

Template for markdown roles uses `<div class="content md-content">{@html rendered}</div>` when `rendered` is non-empty; falls back to `<div class="content">{content}</div>` (plain text) while the Shiki singleton initializes on first use.

All other roles (`tool_call`, `tool_result`, `alert`, `system`) are unchanged.

### CSS Approach

`:global(.md-content ...)` selectors inside `MessageBubble.svelte`'s `<style>` block. Keeps styles co-located with the component. Shiki supplies all code-block colors via inline `style` attributes (tokyo-night theme) — no separate theme CSS file needed.

Key style decisions:
- **Headings** scaled down (h1: 1.25rem, h2: 1.1rem, h3: 1rem) — messages are not documents
- **Tables** wrapped in `.table-wrap { overflow-x: auto }` — no cell wrapping
- **Inline code** — IBM Plex Mono, `var(--bg-2)` background, 3 px border-radius
- **Thinking blocks** — left border in `var(--line-6)` (Hanzomon purple), 0.75 opacity; `<summary>` in `var(--text-secondary)`
- **Blockquotes, lists, paragraphs** — standard resets using existing `--text-*` / `--bg-*` CSS variables

### New Dependencies (`packages/web/package.json`)

```json
"marked": "^17.0.5",
"marked-highlight": "^2.2.3",
"shiki": "^4.0.2",
"dompurify": "^3.3.3",
"@types/dompurify": "^3.2.0"
```

> Shiki is at 4.0.2 — implementation should verify `createHighlighter` API against Shiki 4.x docs before coding, as the API changed across major versions.

---

## Existing Patterns

Investigation found no existing markdown handling, sanitization, or syntax highlighting in the codebase. `MessageBubble.svelte` currently binds content as plain text via `{content}` (Svelte auto-escapes).

This design introduces new patterns:
- A dedicated rendering utility module (`markdown.ts`) for client-side HTML generation
- `{@html}` injection with explicit DOMPurify sanitization — this is the project's first use of `{@html}`

Styling follows the existing convention of scoped-per-component `<style>` blocks with CSS variables from the Tokyo Metro design system (`--line-*`, `--text-*`, `--bg-*`, `--border`).

---

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: `markdown.ts` Module

**Goal:** Implement the full rendering pipeline as a standalone, testable module.

**Components:**
- `packages/web/package.json` — add `marked`, `marked-highlight`, `shiki`, `dompurify`, `@types/dompurify`
- `packages/web/src/client/markdown.ts` — lazy Shiki singleton, marked + markedHighlight config, custom table renderer, `splitOnThinkingBlocks`, `renderMarkdown` export

**Dependencies:** None (first phase)

**Done when:** `bun install` succeeds; unit tests for `renderMarkdown` pass covering: plain text passthrough, headers/bold/lists, fenced code block with known language, fenced code block with no language, inline code, table (wrapped in `.table-wrap`), single `<thinking>` block, multiple `<thinking>` blocks, `<thinking>` block with markdown content inside, XSS in content is stripped
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: `MessageBubble.svelte` Integration + CSS

**Goal:** Wire `renderMarkdown` into the component and style all markdown elements.

**Components:**
- `packages/web/src/client/components/MessageBubble.svelte` — import `renderMarkdown`, add `$state`/`$effect` for reactive rendering, update template for `assistant`/`user` roles with `md-content` wrapper and plain-text fallback, add all `:global(.md-content *)` CSS styles

**Dependencies:** Phase 1 (`renderMarkdown` available)

**Done when:** Playwright or component tests verify: assistant message with markdown structure renders formatted HTML (not raw markdown text); tool_call message still renders in `<pre>` block; thinking block shows collapsed `<details>`; code block in assistant message has Shiki syntax-highlighted output; plain-text fallback shown before Shiki initializes
<!-- END_PHASE_2 -->

---

## Additional Considerations

**Shiki async init and streaming messages:** The `$effect` re-runs whenever `content` changes, so streaming message updates will trigger re-renders. After the Shiki singleton is warm (first message), re-renders are fast — only `marked.parse` (sync) and `DOMPurify.sanitize` (sync) run; `await highlighterPromise` resolves immediately from cache.

**DOMPurify `ADD_ATTR: ['style']`:** Shiki emits inline `style="color:#..."` attributes for token coloring. DOMPurify strips `style` by default; explicitly allowing it is safe here because: (a) message content is treated as markdown text by `marked`, not raw HTML; (b) Shiki only emits color properties; (c) DOMPurify still strips `javascript:` URLs and event handlers regardless of this setting.
