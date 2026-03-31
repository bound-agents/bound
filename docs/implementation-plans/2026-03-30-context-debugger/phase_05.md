# Context Debugger Implementation Plan - Phase 5

**Goal:** Visual breakdown with colored bar, section list, and sparkline chart.

**Architecture:** Three new Svelte 5 components render the context debug data visually: `ContextBar.svelte` (horizontal stacked proportional bar), `ContextSectionList.svelte` (hierarchical section breakdown), and `ContextSparkline.svelte` (SVG area chart showing token trends). These are wired into `ContextDebugPanel.svelte` from Phase 4. Each section maps to a stable Tokyo Metro line color via CSS custom properties already defined in `App.svelte`.

**Tech Stack:** Svelte 5 (runes: $state, $derived), TypeScript, inline SVG, plain scoped CSS

**Scope:** 5 phases from original design (phase 5 of 5)

**Codebase verified:** 2026-03-31

**Testing reference:** This phase is UI visualization. Verification is operational (visual inspection + build success). No component unit tests — follows existing project pattern.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### context-debugger.AC5: Debug Side Panel UI (visualization)
- **context-debugger.AC5.5 Success:** Proportional stacked bar renders sections with correct Tokyo Metro colors and proportional widths
- **context-debugger.AC5.6 Success:** Section list shows name, token count, and percentage for each section
- **context-debugger.AC5.7 Success:** History section expands to show user/assistant/tool_result children
- **context-debugger.AC5.8 Success:** Turn navigation arrows browse between turns, with latest selected by default
- **context-debugger.AC5.9 Success:** Sparkline SVG chart shows token usage trend across turns with selected turn highlighted
- **context-debugger.AC5.10 Success:** Actual vs estimated token line displays both values when actual is available

---

<!-- START_SUBCOMPONENT_A (tasks 1-4) -->

<!-- START_TASK_1 -->
### Task 1: Create ContextBar.svelte — proportional stacked bar

**Verifies:** context-debugger.AC5.5

**Files:**
- Create: `packages/web/src/client/components/ContextBar.svelte`

**Implementation:**

A horizontal stacked bar chart where each segment's width is proportional to its token count relative to the context window. Each section is colored with its assigned Tokyo Metro CSS variable.

**Props:**
```typescript
interface Props {
	sections: Array<{ name: string; tokens: number; children?: Array<{ name: string; tokens: number }> }>;
	contextWindow: number;
}
```

**Color mapping:** Import from the shared `context-colors.ts` module (created as a prerequisite at the start of this task — see below).

**Prerequisite: Create `packages/web/src/client/lib/context-colors.ts`** before this component:

```typescript
export const SECTION_COLORS: Record<string, string> = {
	"system": "var(--line-0)",       // Ginza orange
	"tools": "var(--line-1)",        // Marunouchi red
	"history": "var(--line-6)",      // Hanzomon purple
	"memory": "var(--line-4)",       // Chiyoda green
	"task-digest": "var(--line-3)",  // Tozai sky blue
	"skill-context": "var(--line-5)", // Yurakucho gold
	"volatile-other": "var(--line-7)", // Namboku emerald
};
export const FREE_SPACE_COLOR = "var(--text-muted)"; // Neutral gray
```

**Import in ContextBar.svelte:**
```typescript
import { SECTION_COLORS, FREE_SPACE_COLOR } from "../lib/context-colors";
```

**Template:**
```svelte
<div class="context-bar">
	{#each sections as section}
		{@const pct = (section.tokens / contextWindow) * 100}
		{#if pct > 0}
			<div
				class="bar-segment"
				style="flex-basis: {pct}%; background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'};"
				title="{section.name}: {section.tokens.toLocaleString()} tokens ({pct.toFixed(1)}%)"
			></div>
		{/if}
	{/each}
	{@const usedPct = sections.reduce((s, sec) => s + sec.tokens, 0) / contextWindow * 100}
	{@const freePct = 100 - usedPct}
	{#if freePct > 0}
		<div
			class="bar-segment free"
			style="flex-basis: {freePct}%; background: {FREE_SPACE_COLOR};"
			title="Free space: {Math.round(contextWindow - sections.reduce((s, sec) => s + sec.tokens, 0)).toLocaleString()} tokens ({freePct.toFixed(1)}%)"
		></div>
	{/if}
</div>
```

**CSS:**
```css
.context-bar {
	display: flex;
	height: 12px;
	border-radius: 3px;
	overflow: hidden;
	margin-bottom: 12px;
	gap: 1px;
}

.bar-segment {
	min-width: 2px;
	transition: flex-basis 0.3s ease;
}

.bar-segment.free {
	opacity: 0.3;
}
```

**Testing:**

Operational verification:
- **context-debugger.AC5.5:** Render with sample sections. Each segment has correct color and proportional width. Free space fills the remainder. Hover tooltip shows name, tokens, and percentage.

**Verification:**

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): create ContextBar proportional stacked bar component`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Create ContextSectionList.svelte — hierarchical section breakdown

**Verifies:** context-debugger.AC5.6, context-debugger.AC5.7

**Files:**
- Create: `packages/web/src/client/components/ContextSectionList.svelte`

**Implementation:**

A list of sections with colored indicator dots, token counts, percentages, and expandable children for the history section. Follows the expand/collapse pattern from `TreeNode.svelte` (which uses `SvelteSet<string>` for tracking expanded state, but for this simpler case a single `$state(false)` suffices).

**Props:**
```typescript
interface Props {
	sections: Array<{ name: string; tokens: number; children?: Array<{ name: string; tokens: number }> }>;
	contextWindow: number;
}
```

**Reactive state:**
```typescript
let expandedSections = $state(new Set<string>());

function toggleSection(name: string) {
	const next = new Set(expandedSections);
	if (next.has(name)) next.delete(name);
	else next.add(name);
	expandedSections = next;
}
```

**Template:**
```svelte
<div class="section-list">
	{#each sections as section}
		{@const pct = contextWindow > 0 ? (section.tokens / contextWindow) * 100 : 0}
		<div class="section-row" class:expandable={section.children && section.children.length > 0}>
			<button
				class="section-toggle"
				onclick={() => section.children ? toggleSection(section.name) : null}
				disabled={!section.children || section.children.length === 0}
			>
				{#if section.children && section.children.length > 0}
					<span class="chevron" class:expanded={expandedSections.has(section.name)}>&#9656;</span>
				{/if}
				<span class="dot" style="background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'}"></span>
				<span class="name">{section.name}</span>
			</button>
			<span class="tokens">{section.tokens.toLocaleString()}</span>
			<span class="pct">{pct.toFixed(1)}%</span>
		</div>
		{#if section.children && expandedSections.has(section.name)}
			{#each section.children as child}
				{@const childPct = contextWindow > 0 ? (child.tokens / contextWindow) * 100 : 0}
				<div class="section-row child">
					<span class="indent"></span>
					<span class="dot small" style="background: {SECTION_COLORS[section.name] ?? 'var(--text-muted)'}; opacity: 0.6;"></span>
					<span class="name">{child.name}</span>
					<span class="tokens">{child.tokens.toLocaleString()}</span>
					<span class="pct">{childPct.toFixed(1)}%</span>
				</div>
			{/each}
		{/if}
	{/each}

	<!-- Free space row -->
	{@const usedTokens = sections.reduce((s, sec) => s + sec.tokens, 0)}
	{@const freeTokens = contextWindow - usedTokens}
	{@const freePct = contextWindow > 0 ? (freeTokens / contextWindow) * 100 : 0}
	{#if freeTokens > 0}
		<div class="section-row">
			<button class="section-toggle" disabled>
				<span class="dot" style="background: var(--text-muted); opacity: 0.3;"></span>
				<span class="name">free space</span>
			</button>
			<span class="tokens">{freeTokens.toLocaleString()}</span>
			<span class="pct">{freePct.toFixed(1)}%</span>
		</div>
	{/if}
</div>
```

Import `SECTION_COLORS` from the shared module created in Task 1:
```typescript
import { SECTION_COLORS } from "../lib/context-colors";
```

**CSS:**
```css
.section-list {
	margin-bottom: 16px;
}

.section-row {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 3px 0;
	font-size: 12px;
}

.section-row.child {
	padding-left: 20px;
}

.section-toggle {
	display: flex;
	align-items: center;
	gap: 6px;
	background: none;
	border: none;
	color: var(--text-secondary);
	cursor: default;
	padding: 0;
	flex: 1;
	min-width: 0;
	font-size: 12px;
	font-family: var(--font-body);
}

.section-toggle:not(:disabled) {
	cursor: pointer;
}

.section-toggle:not(:disabled):hover .name {
	color: var(--text-primary);
}

.chevron {
	font-size: 10px;
	transition: transform 0.15s;
	display: inline-block;
	width: 10px;
}

.chevron.expanded {
	transform: rotate(90deg);
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	flex-shrink: 0;
}

.dot.small {
	width: 6px;
	height: 6px;
}

.name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.tokens {
	font-family: var(--font-mono);
	font-size: 11px;
	color: var(--text-primary);
	text-align: right;
	min-width: 48px;
}

.pct {
	font-family: var(--font-mono);
	font-size: 11px;
	color: var(--text-muted);
	text-align: right;
	min-width: 40px;
}

.indent {
	width: 10px;
}
```

**Testing:**

Operational verification:
- **context-debugger.AC5.6:** Each section row shows colored dot, name, token count, and percentage.
- **context-debugger.AC5.7:** Click on the history section row — children (user, assistant, tool_result) expand below. Click again to collapse.

**Verification:**

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): create ContextSectionList hierarchical breakdown component`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Create ContextSparkline.svelte — SVG area chart

**Verifies:** context-debugger.AC5.9

**Files:**
- Create: `packages/web/src/client/components/ContextSparkline.svelte`

**Implementation:**

An inline SVG area chart showing total estimated tokens across turns. The selected turn is highlighted with a dot. The chart fills the panel width and has a fixed height.

**Props:**
```typescript
interface Props {
	turns: Array<{ context_debug: { totalEstimated: number; contextWindow: number } }>;
	selectedIdx: number;
	onSelectTurn?: (idx: number) => void;
}
```

**Reactive derivations:**

Note: Svelte 5 `$derived` takes an expression for simple values. For block bodies with multiple statements, use `$derived.by(() => { ... })`. The result is accessed as a plain value (NOT as a function call).

```typescript
const WIDTH = 288;  // 320px panel - 32px padding
const HEIGHT = 48;

let points = $derived.by(() => {
	if (turns.length === 0) return [];
	const maxTokens = Math.max(...turns.map(t => t.context_debug.contextWindow));
	return turns.map((turn, i) => ({
		x: turns.length === 1 ? WIDTH / 2 : (i / (turns.length - 1)) * WIDTH,
		y: HEIGHT - (turn.context_debug.totalEstimated / maxTokens) * (HEIGHT - 4),
	}));
});

let pathD = $derived.by(() => {
	if (points.length === 0) return "";
	const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
	return `${line} L ${points[points.length - 1].x} ${HEIGHT} L ${points[0].x} ${HEIGHT} Z`;
});

let selectedPoint = $derived.by(() => {
	const idx = selectedIdx >= 0 ? selectedIdx : points.length - 1;
	return points[idx] ?? null;
});
```

**Important:** Access these as plain values: `points`, `pathD`, `selectedPoint` — NOT as function calls like `points()`. This is a Svelte 5 API requirement.

**Template:**
```svelte
<div class="sparkline-container">
	<svg
		viewBox="0 0 {WIDTH} {HEIGHT}"
		width="100%"
		height={HEIGHT}
		preserveAspectRatio="none"
	>
		<!-- Area fill -->
		{#if pathD}
			<path d={pathD} fill="var(--line-7)" opacity="0.15" />
		{/if}

		<!-- Line -->
		{#if points.length > 1}
			<polyline
				points={points.map(p => `${p.x},${p.y}`).join(" ")}
				fill="none"
				stroke="var(--line-7)"
				stroke-width="1.5"
			/>
		{/if}

		<!-- Clickable hit areas for each turn -->
		{#each points as point, idx}
			<rect
				x={point.x - 8}
				y={0}
				width={16}
				height={HEIGHT}
				fill="transparent"
				style="cursor: pointer;"
				onclick={() => onSelectTurn?.(idx)}
			/>
		{/each}

		<!-- Selected turn highlight -->
		{#if selectedPoint}
			<circle
				cx={selectedPoint.x}
				cy={selectedPoint.y}
				r="3"
				fill="var(--line-7)"
				stroke="var(--bg-primary)"
				stroke-width="1.5"
			/>
		{/if}
	</svg>
</div>
```

**CSS:**
```css
.sparkline-container {
	margin-bottom: 16px;
	padding: 4px 0;
}

svg {
	display: block;
}
```

**Testing:**

Operational verification:
- **context-debugger.AC5.9:** With 5+ turns of data, the sparkline shows an area chart. The selected turn has a highlighted dot. Clicking a different point on the chart selects that turn.

**Verification:**

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): create ContextSparkline SVG area chart component`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire visualization components into ContextDebugPanel and add actual vs estimated display

**Verifies:** context-debugger.AC5.5, context-debugger.AC5.6, context-debugger.AC5.7, context-debugger.AC5.8, context-debugger.AC5.9, context-debugger.AC5.10

**Files:**
- Modify: `packages/web/src/client/components/ContextDebugPanel.svelte` (created in Phase 4)
- Verify: `packages/web/src/client/lib/context-colors.ts` exists (created in Task 1)

**Implementation:**

1. **Extract shared color mapping** into `packages/web/src/client/lib/context-colors.ts`:

```typescript
export const SECTION_COLORS: Record<string, string> = {
	"system": "var(--line-0)",
	"tools": "var(--line-1)",
	"history": "var(--line-6)",
	"memory": "var(--line-4)",
	"task-digest": "var(--line-3)",
	"skill-context": "var(--line-5)",
	"volatile-other": "var(--line-7)",
};
export const FREE_SPACE_COLOR = "var(--text-muted)";
```

2. **Import visualization components** in `ContextDebugPanel.svelte`:

```typescript
import ContextBar from "./ContextBar.svelte";
import ContextSectionList from "./ContextSectionList.svelte";
import ContextSparkline from "./ContextSparkline.svelte";
```

3. **Replace the Phase 4 placeholder comments** in the template with actual components:

```svelte
<!-- In the {:else} block (after turn-summary), replace placeholders -->
<ContextBar
	sections={selectedTurn.context_debug.sections}
	contextWindow={selectedTurn.context_debug.contextWindow}
/>

<ContextSectionList
	sections={selectedTurn.context_debug.sections}
	contextWindow={selectedTurn.context_debug.contextWindow}
/>

<ContextSparkline
	{turns}
	selectedIdx={effectiveIdx}
	onSelectTurn={(idx) => { selectedTurnIdx = idx; }}
/>
```

Where `effectiveIdx` is derived:
```typescript
let effectiveIdx = $derived(selectedTurnIdx >= 0 ? selectedTurnIdx : turns.length - 1);
```

4. **Add actual vs estimated token display** (AC5.10) in the turn-summary section:

```svelte
<div class="summary-row">
	<span>Estimated:</span>
	<span class="mono">{selectedTurn?.context_debug.totalEstimated.toLocaleString()} tokens</span>
</div>
{#if selectedTurn?.tokens_in}
	<div class="summary-row">
		<span>Actual (API):</span>
		<span class="mono">{selectedTurn.tokens_in.toLocaleString()} tokens</span>
	</div>
	{@const diff = selectedTurn.tokens_in - selectedTurn.context_debug.totalEstimated}
	{@const diffPct = ((diff / selectedTurn.context_debug.totalEstimated) * 100).toFixed(1)}
	<div class="summary-row variance">
		<span>Variance:</span>
		<span class="mono">{diff > 0 ? "+" : ""}{diff.toLocaleString()} ({diffPct}%)</span>
	</div>
{/if}
```

**CSS additions for variance display:**
```css
.mono {
	font-family: var(--font-mono);
}

.variance {
	font-size: 11px;
	color: var(--text-muted);
}
```

5. **Turn navigation callback from sparkline** — when `onSelectTurn` fires, update `selectedTurnIdx` in the panel. This satisfies AC5.8 (turn navigation) via both arrow buttons AND sparkline clicks.

**Testing:**

Operational verification:
- **context-debugger.AC5.5:** Proportional bar shows colored segments matching section proportions.
- **context-debugger.AC5.6:** Section list shows name, token count, percentage for each section.
- **context-debugger.AC5.7:** Click history row — children expand showing user/assistant/tool_result breakdown.
- **context-debugger.AC5.8:** Arrow buttons navigate turns. Sparkline click selects a turn. Latest selected by default.
- **context-debugger.AC5.9:** Sparkline shows trend line. Selected turn is highlighted with a dot.
- **context-debugger.AC5.10:** Both estimated and actual token counts shown. Variance computed when actual is available.

Full visual verification:
1. Open a thread with 3+ agent turns
2. Open the debug panel
3. Verify bar, section list, and sparkline render
4. Click history section — should expand to children
5. Navigate turns with arrows — all visualizations update
6. Click a point on the sparkline — turn changes
7. Check actual vs estimated numbers match

**Verification:**

Run: `bun run build`
Expected: Build succeeds

Run: `bun run test:e2e` (if Playwright tests are configured)
Expected: No regressions in existing e2e tests

**Commit:** `feat(web): wire visualization components into context debug panel`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_A -->
