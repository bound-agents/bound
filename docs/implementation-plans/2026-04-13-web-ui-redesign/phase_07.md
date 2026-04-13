# Web UI Redesign — Phase 7: Advisories Redesign

**Goal:** Update advisory cards with severity color banding, source-aware LineBadge, dedup collapse, and grouped organization.

**Architecture:** Refactor AdvisoryView.svelte to use MetroCard, StatusChip, and LineBadge. Add severity band styling and dedup logic.

**Tech Stack:** Svelte 5, shared components from Phase 1

**Scope:** 8 phases from original design (phase 7 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- AdvisoryView.svelte: 719 lines, polls `/api/advisories` every 5s.
- Cards are collapsible buttons with type badges using icons ($, ~, M, A, *).
- Status badges: proposed=orange, approved=green, dismissed=grey, deferred=blue, applied=purple.
- Action buttons: Approve/Dismiss/Defer (if proposed), Apply (if approved).
- Advisory type/interface from shared types includes: id, type, title, detail, action, impact, status, proposed_at, resolved_at, created_by, etc.

---

## Acceptance Criteria Coverage

### ui-redesign.AC17: Severity banding
- **ui-redesign.AC17.1 Success:** Proposed cards have orange 4px top band
- **ui-redesign.AC17.2 Success:** Failed/escalated cards have red band + subtle glow
- **ui-redesign.AC17.3 Success:** Dismissed/deferred cards have muted opacity

### ui-redesign.AC18: Source attribution and dedup
- **ui-redesign.AC18.1 Success:** Source badge shows LineBadge for originating task type, not star icon
- **ui-redesign.AC18.2 Success:** Identical-title advisories collapse into one card with count badge
- **ui-redesign.AC18.3 Success:** Source attribution shows human-readable "from task-name on host-name"

### ui-redesign.AC19: List organization
- **ui-redesign.AC19.1 Success:** Unresolved (proposed, approved) grouped at top
- **ui-redesign.AC19.2 Success:** Resolved (applied, dismissed, deferred) in collapsible section below

---

<!-- START_TASK_1 -->
### Task 1: Create advisory dedup utility with tests

**Verifies:** ui-redesign.AC18.2

**Files:**
- Create: `packages/web/src/client/lib/advisory-utils.ts`
- Create: `packages/web/src/client/lib/__tests__/advisory-utils.test.ts`

**Implementation:**

`advisory-utils.ts`:
- `export function deduplicateAdvisories(advisories): DedupedAdvisory[]`
  - Groups advisories by `title + status`
  - For groups with count > 1: collapse into single entry with `count: N` and `sources: Advisory[]`
  - For singles: `count: 1`, `sources: [advisory]`
  - Returns sorted: unresolved first (proposed, approved), then resolved (applied, dismissed, deferred), within groups by most recent `proposed_at`

- `export interface DedupedAdvisory { representative: Advisory; count: number; sources: Advisory[] }`

**Testing:**
- 5 advisories with same title + status → one DedupedAdvisory with count=5
- Mix of same/different titles → correct grouping
- Unresolved sort before resolved
- Within same status group, most recent first

**Verification:**
Run: `bun test packages/web/src/client/lib/__tests__/advisory-utils.test.ts`
Expected: All tests pass

**Commit:** `feat(web): add advisory dedup utility with tests`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Rewrite AdvisoryView.svelte

**Verifies:** ui-redesign.AC17.1, ui-redesign.AC17.2, ui-redesign.AC17.3, ui-redesign.AC18.1, ui-redesign.AC18.3, ui-redesign.AC19.1, ui-redesign.AC19.2

**Files:**
- Modify: `packages/web/src/client/views/AdvisoryView.svelte` (major refactor — 719 lines → ~350 lines)

**Implementation:**

Import shared components + `deduplicateAdvisories` from advisory-utils.

Data fetching: Keep existing `/api/advisories` polling.

Apply dedup: `const deduped = $derived(deduplicateAdvisories(advisories))`.

**Severity banding**: Each `MetroCard` gets a 4px top border via a wrapper div:
```css
.severity-band-proposed { border-top: 4px solid var(--alert-warning); }
.severity-band-approved { border-top: 4px solid var(--status-active); }
.severity-band-failed { border-top: 4px solid var(--alert-disruption); box-shadow: 0 0 12px rgba(255, 23, 68, 0.1); }
.severity-band-dismissed, .severity-band-deferred { opacity: 0.6; }
.severity-band-applied { border-top: 4px solid var(--line-6); }
```

**Source badge**: Replace the star icon with `LineBadge`. Derive color from task type in `created_by` context:
- If advisory's `created_by` matches a known host, use host index color
- If advisory title mentions a task type keyword (cron, heartbeat), use task type color mapping
- Fallback: `--alert-warning` orange

**Source attribution**: Below the title, show: `"from {taskDisplayName} on {hostName}"`. The advisory `created_by` is a site_id — resolve to host_name by fetching `/api/status/network` once on component mount and building a `Map<string, string>` (siteId → hostName) for lookups. Store this map in component state: `let hostNameMap = $state<Map<string, string>>(new Map())`.

**Dedup display**: When `deduped.count > 1`, show count badge next to title (`×5`). The expand reveals a list of individual source entries.

**Group sections**:
- "Unresolved" header + unresolved cards
- Collapsible "Resolved" section with toggle button, starts collapsed

**Action buttons**: Keep Approve/Dismiss/Defer/Apply logic but style as small outline buttons in card footer: `background: transparent; border: 1px solid var(--text-muted); border-radius: 4px; padding: 4px 12px; font-size: var(--text-xs)`.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): rewrite AdvisoryView with severity bands, dedup, and shared components`
<!-- END_TASK_2 -->
