# Outbox Bypass Audit Report
Generated: 2026-04-02

## Executive Summary
Systematic search across all synced tables identified **1 NEW bypass** and confirmed **5 known intentional bypasses**.

## Synced Tables Audited
1. users
2. threads
3. messages
4. semantic_memory
5. tasks
6. files
7. hosts
8. overlay_index
9. cluster_config
10. advisories
11. skills

---

## NEW BYPASS (Critical)

### 1. Sync-loop alert creation bypasses outbox
**File**: `packages/sync/src/sync-loop.ts:160-176`
**Tables**: `threads`, `messages`
**Operation**: INSERT
**Severity**: HIGH

**Context**: When sync failures reach threshold (5 consecutive errors), the sync loop creates a system alert thread and message directly via raw SQL, bypassing the change-log outbox.

**Code**:
```typescript
// Line 160-164: threads INSERT
this.db
  .query(
    `INSERT OR IGNORE INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, 'system', 'web', ?, 0, 'System Alerts', NULL, ?, ?, ?, 0)`,
  )
  .run(systemThreadId, this.siteId, now, now, now);

// Line 165-176: messages INSERT
this.db
  .query(
    `INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, 'alert', ?, NULL, NULL, ?, ?, ?, 0)`,
  )
  .run(
    randomUUID(),
    systemThreadId,
    `Sync to peer ${peerSiteId} has failed ${syncState.sync_errors} consecutive times`,
    now,
    now,
    this.siteId,
  );
```

**Impact**: Sync alert messages never propagate to other hosts. If a spoke experiences sync failures to the hub, the hub never learns about it. This defeats the purpose of the alert system.

**Suggested Fix**:
```typescript
import { insertRow } from "@bound/core";

// Line 160-164: Use insertRow for threads
insertRow(this.db, "threads", {
  id: systemThreadId,
  user_id: "system",
  interface: "web",
  host_origin: this.siteId,
  color: 0,
  title: "System Alerts",
  summary: null,
  created_at: now,
  last_message_at: now,
  modified_at: now,
  deleted: 0,
}, this.siteId);

// Line 165-176: Use insertRow for messages
insertRow(this.db, "messages", {
  id: randomUUID(),
  thread_id: systemThreadId,
  role: "alert",
  content: `Sync to peer ${peerSiteId} has failed ${syncState.sync_errors} consecutive times`,
  model_id: null,
  tool_name: null,
  created_at: now,
  modified_at: now,
  host_origin: this.siteId,
  deleted: 0,
}, this.siteId);
```

**Note**: The existing code uses `INSERT OR IGNORE` for threads (idempotent), but `insertRow` doesn't support this. Need to either:
1. Check existence first: `const existing = db.query("SELECT id FROM threads WHERE id = ?").get(systemThreadId)` and skip if found, OR
2. Wrap in try/catch and ignore UNIQUE constraint errors

---

## KNOWN INTENTIONAL BYPASSES (Documented)

### 2. Scheduler task table writes (Performance optimization)
**File**: `packages/agent/src/scheduler.ts` (multiple locations)
**Table**: `tasks`
**Operations**: UPDATE (status transitions, heartbeat, error tracking)
**Status**: DOCUMENTED in CLAUDE.md
**Justification**: High-frequency writes (heartbeat every ~failover_threshold/3). Using outbox would create excessive changelog entries. Tasks are not truly collaborative data — only the claiming host modifies them.

**Lines**:
- Line 47: `rescheduleCronTask()`
- Line 171: heartbeat UPDATE
- Line 214, 228: phase0Eviction UPDATE
- Line 264, 293: phase1Schedule CAS UPDATE
- Line 337: phase2Execute UPDATE
- Line 362: thread_id assignment
- Line 431, 462, 483, 508: error/completion tracking
- Line 578, 686, 701: template task execution

**Impact**: Tasks don't sync. This is acceptable because tasks are claimed by a single host and status transitions are local.

### 3. Host registration at startup
**File**: `packages/cli/src/commands/start.ts:220-256`
**Table**: `hosts`
**Operations**: INSERT, UPDATE
**Status**: DOCUMENTED in CLAUDE.md (was listed as bypass, but is actually using outbox!)
**Classification**: **FALSE ALARM** — Actually uses `withChangeLog()` wrapper (lines 221-235 for UPDATE, 244-255 for INSERT)

**Correction**: This is NOT a bypass. The code wraps both INSERT and UPDATE in `withChangeLog()` which manually creates changelog entries. The PK issue (site_id vs id) is handled correctly.

### 4. Platform leader election heartbeat
**File**: `packages/platforms/src/leader-election.ts:94-108`
**Table**: `hosts`
**Operation**: UPDATE (modified_at)
**Status**: DOCUMENTED in CLAUDE.md and inline comments
**Justification**: High-frequency heartbeat (every ~failover_threshold/3). Uses manual transaction + changelog entry. PK is site_id (not id), so updateRow() cannot be used.

**Code includes manual changelog**:
```typescript
this.db.transaction(() => {
  this.db.run("UPDATE hosts SET modified_at = ? WHERE site_id = ?", [ts, this.siteId]);
  this.db.run(
    "INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES ('hosts', ?, ?, ?, ?)",
    [this.siteId, this.siteId, ts, JSON.stringify({ site_id: this.siteId, modified_at: ts })],
  );
})();
```

### 5. Cluster_config writes (Leader election, stop/resume, drain, config-reload, cache-pin/unpin)
**Files**:
- `packages/cli/src/commands/stop-resume.ts:26-46, 72-78`
- `packages/cli/src/commands/config-reload.ts:77-98`
- `packages/cli/src/commands/drain.ts:40-60, 88-106`
- `packages/platforms/src/leader-election.ts:69-85`
- `packages/agent/src/commands/cache-pin.ts:10-28`
- `packages/agent/src/commands/cache-unpin.ts:10-28`

**Table**: `cluster_config`
**Operations**: INSERT, UPDATE, DELETE
**Status**: DOCUMENTED in CLAUDE.md, inline comments, and PLATFORMS CLAUDE.md
**Justification**: PK is `key` (not `id`), so insertRow/updateRow cannot be used. All implementations use manual transaction + changelog entry following the documented pattern.

**Pattern**:
```typescript
db.transaction(() => {
  db.run("INSERT INTO cluster_config ... ON CONFLICT(key) DO UPDATE ...");
  db.run("INSERT INTO change_log (table_name, row_id, ...) VALUES ('cluster_config', key, ...)");
})();
```

### 6. Overlay-scanner (FIXED as of 2026-04-02)
**File**: `packages/sandbox/src/overlay-scanner.ts`
**Table**: `overlay_index`
**Status**: **FIXED** — Now uses outbox when available (lines 104-109, 118-121, 139-140)
**Classification**: **NOT A BYPASS**

The scanner accepts an optional `OverlayOutbox` parameter and uses `insertRow/updateRow/softDelete` when provided. Fallback to direct SQL only when running standalone (backward compat). Start.ts passes outbox (line 1050-1057).

---

## Test Files (Excluded from audit)
All matches in `__tests__/` directories were excluded as they use direct SQL for test data setup. This is acceptable test practice.

---

## Summary Table

| ID | File | Table(s) | Status | Severity |
|----|------|----------|--------|----------|
| 1  | sync-loop.ts | threads, messages | **NEW BYPASS** | HIGH |
| 2  | scheduler.ts | tasks | Known (documented) | N/A |
| 3  | start.ts | hosts | **FALSE ALARM** (uses outbox) | N/A |
| 4  | leader-election.ts | hosts | Known (documented) | N/A |
| 5  | stop-resume.ts, drain.ts, config-reload.ts, cache-*.ts, leader-election.ts | cluster_config | Known (documented) | N/A |
| 6  | overlay-scanner.ts | overlay_index | **FIXED** (uses outbox) | N/A |

---

## Recommendations

### Immediate Action Required
1. **Fix sync-loop alert bypass** (HIGH priority): Refactor `packages/sync/src/sync-loop.ts:160-176` to use `insertRow()` from `@bound/core`. Handle `INSERT OR IGNORE` semantics via explicit existence check.

### Documentation Updates
2. Update CLAUDE.md to reflect:
   - Host registration at startup (start.ts) correctly uses `withChangeLog()` — remove from bypass list
   - overlay-scanner.ts now uses outbox when available — remove from bypass list
   - Add sync-loop alert creation to known bypasses once fixed

### Testing
3. Add integration test for sync alert propagation:
   - Simulate 5 consecutive sync failures on spoke A
   - Verify alert message appears in hub's system thread
   - Verify alert message syncs to spoke B

### Monitoring
4. Consider adding metrics for:
   - Changelog entries per table (detect future bypasses)
   - Sync alert delivery latency (once fixed)

---

## Search Methodology
Systematic grep across all synced tables for:
- `INSERT INTO <table>`
- `UPDATE <table>`
- `DELETE FROM <table>`

Filtered results to exclude:
- `__tests__/` directories
- `schema.ts` / migration files
- `change-log.ts` itself

Manually reviewed each match to determine:
1. Direct SQL vs outbox pattern
2. Known vs new bypass
3. Documented justification

---

## Appendix: Verification Commands

```bash
# Search for threads table writes (excluding tests)
grep -rn 'INSERT INTO threads' --include='*.ts' packages/ | grep -v __tests__ | grep -v schema | grep -v change-log

# Search for messages table writes (excluding tests)
grep -rn 'INSERT INTO messages' --include='*.ts' packages/ | grep -v __tests__ | grep -v schema | grep -v change-log

# Verify sync-loop.ts bypass
grep -A 20 'INSERT INTO threads' packages/sync/src/sync-loop.ts

# Verify start.ts uses withChangeLog
grep -B 5 -A 15 'UPDATE hosts SET host_name' packages/cli/src/commands/start.ts

# Verify overlay-scanner uses outbox
grep -A 3 'if (outbox)' packages/sandbox/src/overlay-scanner.ts
```
