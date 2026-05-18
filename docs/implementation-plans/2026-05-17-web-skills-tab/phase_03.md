# Web Skills Tab — Phase 3: UI Routing + SkillsView

**Goal:** Skills tab visible in navigation, list view with filtering, expanded detail, content rendering, and retire/re-activate actions

**Architecture:** A new `SkillsView.svelte` component following existing view patterns (AdvisoryView): `$state` for reactive data, 5s polling via BoundClient, DataTable with expandable rows, StatusChip for status display, `renderMarkdown()` for SKILL.md rendering, action buttons with progress tracking.

**Tech Stack:** Svelte 5, BoundClient (from Phase 2), DataTable, StatusChip, renderMarkdown

**Scope:** 5 phases from original design (phase 3 of 5)

**Codebase verified:** 2026-05-17

---

## Acceptance Criteria Coverage

This phase implements and tests:

### web-skills-tab.AC3: UI provides full skill management (partial — list/view/actions)
- **web-skills-tab.AC3.1 Success:** "06 Skills" tab appears in navigation and routes to SkillsView
- **web-skills-tab.AC3.2 Success:** Skills list displays name, status chip, description, and last activated time
- **web-skills-tab.AC3.3 Success:** Status filter toggles between all/active/retired views
- **web-skills-tab.AC3.4 Success:** Expanding a row shows full detail (allowed_tools, compatibility, activation_count, content_hash)
- **web-skills-tab.AC3.5 Success:** "View Content" in expanded row renders SKILL.md as formatted markdown
- **web-skills-tab.AC3.6 Success:** Retire action on active skill sets it to retired (with optional reason)
- **web-skills-tab.AC3.7 Success:** Re-activate action on retired skill sets it back to active

### web-skills-tab.AC5: Content rendering works correctly
- **web-skills-tab.AC5.1 Success:** SKILL.md with code blocks renders with syntax highlighting
- **web-skills-tab.AC5.2 Success:** SKILL.md with headers, lists, and tables renders formatted HTML
- **web-skills-tab.AC5.3 Success:** Supplementary files (references/) displayed as path + size list

---

<!-- START_TASK_1 -->
### Task 1: Add navigation entry and route for Skills tab

**Verifies:** web-skills-tab.AC3.1

**Files:**
- Modify: `packages/web/src/client/components/TopBar.svelte` (add NAV entry)
- Modify: `packages/web/src/client/App.svelte` (add route + import)

**Implementation:**

In `TopBar.svelte`, add to the NAV array (after the "05 Files" entry):
```typescript
{ hash: "#/skills", route: "06", label: "Skills" },
```

In `App.svelte`:
1. Add import: `import SkillsView from "./views/SkillsView.svelte";`
2. Add route in the if/else chain (before the final `{:else}`):
   ```svelte
   {:else if route === "/skills"}
   	<SkillsView />
   ```
3. Add to `screenLabel()` function (before the final `return "00 Unknown"`): `if (r === "/skills") return "07 Skills";`
   Note: screenLabel numbering includes the non-NAV "02 Line" route, so Files is "06" and Skills follows as "07". The NAV `route` field ("06") is separate from screenLabel numbering.

For now, create a minimal placeholder `SkillsView.svelte` to verify routing works:

```svelte
<script lang="ts">
	import Page from "../components/Page.svelte";
	import SectionHeader from "../components/SectionHeader.svelte";
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={6} title="Skills" />
		<div class="state">Loading...</div>
	{/snippet}
</Page>

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--text-dim);
	}
</style>
```

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

Run: `bun run build` (or the Vite build for the web package)
Expected: Build succeeds

**Commit:** `feat(web): add Skills tab navigation entry and route`
<!-- END_TASK_1 -->

<!-- START_SUBCOMPONENT_A (tasks 2-3) -->
<!-- START_TASK_2 -->
### Task 2: Implement SkillsView list with DataTable, polling, and status filter

**Verifies:** web-skills-tab.AC3.2, web-skills-tab.AC3.3

**Files:**
- Modify: `packages/web/src/client/views/SkillsView.svelte` (replace placeholder with full implementation)

**Implementation:**

Replace the placeholder with the full SkillsView component. Structure:

**Script block:**
```typescript
import type { Skill } from "@bound/shared";
import { onDestroy, onMount } from "svelte";
import { client } from "../lib/bound";
import DataTable from "../components/DataTable.svelte";
import StatusChip from "../components/StatusChip.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";

let skills: Skill[] = $state([]);
let loading = $state(true);
let statusFilter = $state<"all" | "active" | "retired">("all");
let expandedId = $state<string | null>(null);
let pollInterval: ReturnType<typeof setInterval> | null = null;

const filteredSkills = $derived(
	statusFilter === "all"
		? skills
		: skills.filter((s) => s.status === statusFilter),
);

const columns = [
	{ key: "name", label: "Name", width: "200px", sortable: true },
	{ key: "status", label: "Status", width: "100px", sortable: true },
	{ key: "description", label: "Description", width: "1fr" },
	{ key: "last_activated_at", label: "Last Activated", width: "180px", sortable: true },
];

async function loadSkills(): Promise<void> {
	try {
		skills = await client.listSkills();
	} catch (error) {
		console.error("Failed to load skills:", error);
	}
	loading = false;
}

onMount(() => {
	loadSkills();
	pollInterval = setInterval(loadSkills, 5000);
});

onDestroy(() => {
	if (pollInterval !== null) clearInterval(pollInterval);
});
```

**Template:**
- SectionHeader with number={6} title="Skills"
- Filter buttons for "All" / "Active" / "Retired" (set `statusFilter`)
- DataTable with `columns`, `rows={filteredSkills}`, `expandable={true}`, `sortable={true}`
- StatusChip in the status column (render via DataTable's column rendering — or render inline if DataTable uses raw values; check: the status column value should display as a StatusChip)

Note: DataTable renders raw cell values as text. For StatusChip integration, use `rowAccent` to color-code rows by status, and display StatusChip in the expanded content. Alternatively, if DataTable supports custom cell rendering via column formatter, use that. Based on investigation, DataTable renders `row[column.key]` directly — so the status column shows the text value. StatusChip should appear in the expanded row detail instead.

The filter buttons should be styled consistently with existing UI — use `<button>` elements with a class like `filter-btn` and an `active` state class.

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): implement SkillsView list with DataTable and status filter`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add expanded row detail with content rendering and file list

**Verifies:** web-skills-tab.AC3.4, web-skills-tab.AC3.5, web-skills-tab.AC5.1, web-skills-tab.AC5.2, web-skills-tab.AC5.3

**Files:**
- Modify: `packages/web/src/client/views/SkillsView.svelte` (add expandedContent snippet and content loading)

**Implementation:**

Add to the script block:
```typescript
import { renderMarkdown } from "../lib/markdown";
import { untrack } from "svelte";

let skillDetail = $state<Record<string, { content: string; files: { path: string; size: number }[] } | null>>({});
let renderedContent = $state<Record<string, string>>({});
let contentLoading = $state<string | null>(null);
```

Add a function to load skill detail on expand:
```typescript
async function loadSkillDetail(id: string): Promise<void> {
	if (skillDetail[id]) return; // already loaded
	contentLoading = id;
	try {
		const detail = await client.getSkill(id);
		skillDetail = { ...skillDetail, [id]: { content: detail.content, files: detail.files } };
		// Render markdown
		const html = await renderMarkdown(detail.content);
		renderedContent = { ...renderedContent, [id]: html };
	} catch (error) {
		console.error("Failed to load skill detail:", error);
	}
	contentLoading = null;
}
```

Toggle expand and trigger load:
```typescript
function toggleExpand(id: string): void {
	if (expandedId === id) {
		expandedId = null;
	} else {
		expandedId = id;
		loadSkillDetail(id);
	}
}
```

Add the expandedContent snippet to the DataTable. The expanded row shows:
- **Metadata fields:** allowed_tools, compatibility, activation_count, content_hash (from the skill row in `skills` array)
- **"View Content" section:** renders SKILL.md as formatted markdown using `{@html renderedContent[skill.id]}` inside a `.skill-content.md-content` div
- **File list:** displays supplementary files as `path (size)` list from `skillDetail[id]?.files`

Style the expanded content:
```css
.skill-detail { padding: 12px 16px; }
.skill-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 12px; }
.skill-meta dt { color: var(--text-dim); font-size: 0.85em; }
.skill-meta dd { margin: 0; font-family: var(--font-mono); font-size: 0.85em; }
.skill-content { margin-top: 12px; padding: 12px; background: var(--bg-inset); border-radius: 4px; }
.file-list { margin-top: 12px; }
.file-list li { font-family: var(--font-mono); font-size: 0.85em; color: var(--text-dim); }
```

Use `:global(.skill-content)` prefix for markdown content styles (h1-h6, code, pre, tables, etc.) — or rely on the existing `:global(.md-content)` styles from MessageBubble which are already global.

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): add expanded row detail with markdown rendering and file list`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_4 -->
### Task 4: Add retire and re-activate action buttons

**Verifies:** web-skills-tab.AC3.6, web-skills-tab.AC3.7

**Files:**
- Modify: `packages/web/src/client/views/SkillsView.svelte` (add action buttons in expanded row)

**Implementation:**

Add action tracking state:
```typescript
let actionInProgress = $state<string | null>(null);
let retireReason = $state("");
let showRetireInput = $state<string | null>(null);
```

Add action handlers:
```typescript
async function retireSkill(id: string): Promise<void> {
	actionInProgress = `${id}:retire`;
	try {
		await client.retireSkill(id, retireReason || undefined);
		retireReason = "";
		showRetireInput = null;
		await loadSkills();
	} catch (error) {
		console.error("Failed to retire skill:", error);
	}
	actionInProgress = null;
}

async function activateSkill(id: string): Promise<void> {
	actionInProgress = `${id}:activate`;
	try {
		await client.activateSkill(id);
		// Clear cached detail so it reloads with fresh data
		const newDetail = { ...skillDetail };
		delete newDetail[id];
		skillDetail = newDetail;
		await loadSkills();
	} catch (error) {
		console.error("Failed to activate skill:", error);
	}
	actionInProgress = null;
}
```

In the expanded row template, show action buttons conditionally based on skill status:
- If `status === "active"`: show "Retire" button. Clicking it either:
  - Shows a small text input for optional reason + "Confirm Retire" button
  - Or directly retires (simpler UX — show input inline, confirm on second click)
- If `status === "retired"`: show "Re-activate" button

Button pattern (follows AdvisoryView):
```svelte
{#if skill.status === "active"}
	{#if showRetireInput === skill.id}
		<input type="text" bind:value={retireReason} placeholder="Reason (optional)" />
		<Btn size="sm" variant="danger" disabled={actionInProgress === `${skill.id}:retire`}
			onclick={() => retireSkill(skill.id)}>
			Confirm Retire
		</Btn>
	{:else}
		<Btn size="sm" onclick={() => { showRetireInput = skill.id; }}>
			Retire
		</Btn>
	{/if}
{:else if skill.status === "retired"}
	<Btn size="sm" variant="accent" disabled={actionInProgress === `${skill.id}:activate`}
		onclick={() => activateSkill(skill.id)}>
		Re-activate
	</Btn>
{/if}
```

Import `Btn` component: `import Btn from "../components/Btn.svelte";`

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): add retire and re-activate action buttons to SkillsView`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Add StatusChip support for "retired" status

**Files:**
- Modify: `packages/web/src/client/components/StatusChip.svelte` (add "retired" to status map if not present)

**Implementation:**

Check if "retired" is already in the StatusChip's status mapping. Based on investigation, the component supports: active, running, claimed, pending, idle, failed, cancelled, completed, delayed, overdue, proposed, approved, dismissed, deferred, applied, healthy, degraded, unreachable, online, offline.

"retired" is NOT in the list. Add it to the status configuration:
```typescript
retired: { label: "Retired", color: "var(--text-dim)", pulse: false },
```

This gives it a gray/dim color with no pulse animation, indicating an inactive state.

Also add the type to the `StatusType` union if it's manually defined (or if it uses a map, add the key).

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): add retired status to StatusChip component`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Integrate StatusChip into SkillsView list rows

**Files:**
- Modify: `packages/web/src/client/views/SkillsView.svelte` (render StatusChip for skill status in the list)

**Implementation:**

DataTable renders raw cell values as text. Use `rowAccent` to color-code rows by status (green for active, gray for retired). StatusChip is shown in the expanded detail section (Task 3).

Add `rowAccent` to the DataTable usage:
```typescript
function getRowAccent(row: Record<string, unknown>): string | null {
	if (row.status === "active") return "var(--color-green)";
	if (row.status === "retired") return "var(--text-dim)";
	return null;
}
```

Pass `rowAccent={getRowAccent}` to DataTable.

**Verification:**

Run: `tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `feat(web): add status accent colors to skills list`
<!-- END_TASK_6 -->
