# Web UI Redesign — Phase 6: Network Status Redesign

**Goal:** Replace the current host cards and sync mesh table with a topology schematic, MetroCard-based host cards with fixed status semantics, and a proper DataTable for sync mesh.

**Architecture:** Rewrite NetworkStatus.svelte to use shared components. Add a static SVG topology diagram. Fix the "Offline" + "Sync: Healthy" contradiction.

**Tech Stack:** Svelte 5, SVG, shared components from Phase 1

**Scope:** 8 phases from original design (phase 6 of 8)

**Codebase verified:** 2026-04-13

**Investigation findings:**
- NetworkStatus.svelte: 657 lines, fetches `/api/status/network`, polls every 10s.
- Host cards use auto-fill grid (`minmax(340px, 1fr)`), 3px top border for online/offline.
- Sync mesh table: 5-column grid (`1fr 80px 80px 120px 80px`), HLC timestamps overflow.
- Host badge: SVG circle with letter (A, B, C or H for hub).
- `hosts.models` parsed from JSON as string[] or HostModelEntry[].

---

## Acceptance Criteria Coverage

### ui-redesign.AC14: Topology schematic
- **ui-redesign.AC14.1 Success:** SVG diagram shows hub as central interchange node, spokes as branch nodes
- **ui-redesign.AC14.2 Success:** Connection lines colored by sync health (green/orange/red/grey)

### ui-redesign.AC15: Host cards
- **ui-redesign.AC15.1 Success:** Cards use MetroCard with LineBadge for host identity
- **ui-redesign.AC15.2 Success:** "Online" = last seen within 5 minutes, "Offline" = beyond 5 minutes. No more status contradiction.
- **ui-redesign.AC15.3 Success:** Models and MCP tools shown as small pills

### ui-redesign.AC16: Sync Mesh table
- **ui-redesign.AC16.1 Success:** Uses DataTable with properly sized columns
- **ui-redesign.AC16.2 Success:** Peer column shows host name, not raw site ID
- **ui-redesign.AC16.3 Success:** Error count color-coded (0=green, >0=red)

---

<!-- START_TASK_1 -->
### Task 1: Create TopologyDiagram component

**Verifies:** ui-redesign.AC14.1, ui-redesign.AC14.2

**Files:**
- Create: `packages/web/src/client/components/TopologyDiagram.svelte`

**Implementation:**

Static SVG schematic of the hub-spoke topology. Compact (~150px tall).

Props:
- `hosts: Host[]` — host list from API
- `hub: { siteId: string; hostName: string } | null` — hub info
- `syncHealth: Map<string, "healthy" | "degraded" | "unreachable" | "unknown">` — per-peer sync status

Layout algorithm:
- Hub node at center (`cx = width/2, cy = 75`)
- Spoke nodes arranged in a horizontal row below (`cy = 130`), spaced evenly
- Hub: double circle (outer 20px, inner 14px), white fill, dark stroke
- Spokes: `LineBadge`-style circle (16px), colored by host index
- Connection lines from hub to each spoke, colored by sync health:
  - `healthy` → `var(--status-active)` green
  - `degraded` → `var(--alert-warning)` orange
  - `unreachable` → `var(--alert-disruption)` red
  - `unknown` → `var(--text-muted)` grey

SVG `viewBox` adapts to number of spokes. Min width 300px, max 600px.

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

**Commit:** `feat(web): add TopologyDiagram component`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Rewrite NetworkStatus.svelte

**Verifies:** ui-redesign.AC15.1, ui-redesign.AC15.2, ui-redesign.AC15.3, ui-redesign.AC16.1, ui-redesign.AC16.2, ui-redesign.AC16.3

**Files:**
- Modify: `packages/web/src/client/views/NetworkStatus.svelte` (full rewrite — 657 lines → ~300 lines)

**Implementation:**

**Remove**: Custom host card styling, SVG badge circles, the broken online/offline logic, the custom sync mesh grid.

**New structure**:

Import shared components + TopologyDiagram.

Data fetching: Keep existing `/api/status/network` polling.

**Status semantics fix**: Compute online status from `online_at`:
```typescript
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const isOnline = (host) => host.online_at && (Date.now() - Date.parse(host.online_at) < ONLINE_THRESHOLD_MS);
```

**Sync health computation**: Derive from `syncState` data — healthy if last sync < 5min and errors = 0, degraded if errors > 0, unreachable if last sync > 10min, unknown if no data.

Layout:
1. `SectionHeader` title "Network Status", subtitle "CLUSTER TOPOLOGY"
2. `TopologyDiagram` with hosts, hub, syncHealth
3. Host cards grid (`display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px`):
   - Each host as `MetroCard` with `accentColor` from `getLineColor(hostIndex)`
   - Header: `LineBadge` (hostIndex) + host name (fall back to truncated site_id) + `StatusChip` (online/offline)
   - Key-value rows: Site ID (full, with copy-on-click button), Last Seen, Sync Status (StatusChip), Last Sync, Models (as small colored pills), MCP Tools (as small pills)
   - Red accent border ONLY for unreachable hosts

4. "Sync Mesh" section with `DataTable`:
   - Columns: Peer (host name), Sent (HLC, mono), Received (HLC, mono), Last Sync (relative), Errors (color-coded count)
   - Resolve peer site_id to host_name via a lookup map from the hosts array

**Verification:**
Run: `bun test packages/web`
Expected: Existing tests pass

Run: `bun run build`
Expected: Build succeeds

**Commit:** `feat(web): rewrite NetworkStatus with topology diagram and shared components`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Add network status e2e test

**Files:**
- Create: `e2e/network-status.spec.ts`

**Testing:**
- Verify TopologyDiagram SVG element renders
- Verify host cards contain LineBadge elements
- Verify StatusChip shows correct online/offline state
- Verify Sync Mesh DataTable renders with column headers

**Verification:**
Run: `bun run test:e2e`
Expected: All e2e tests pass

**Commit:** `test(web): add Network Status e2e tests`
<!-- END_TASK_3 -->
