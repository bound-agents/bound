# Cache-Stable Prefix Implementation Plan — Phase 3

**Goal:** Switch all volatile system messages to `developer` role, so the only remaining `system`-role messages are the stable prompt (persona, orientation, skill body). This makes the system/nonSystem split in the agent loop extract only stable content, and all volatile per-turn content flows through `developer` messages that drivers already handle from Phase 1.

**Architecture:** After Phases 1-2, drivers handle `developer` role and volatile enrichment is already a developer message. Phase 3 completes the picture by converting all remaining volatile system messages (model-switch, truncation markers, scheduler wakeup/quiescence, cancellation notices) to `developer` role. The agent loop's system message filter then extracts only the stable prompt — a prerequisite for Phase 4's warm path, which needs to separate cached prefix from per-turn content.

**Tech Stack:** TypeScript, bun:test

**Scope:** 6 phases from original design (this is phase 3 of 6)

**Codebase verified:** 2026-04-23

---

## Acceptance Criteria Coverage

This phase does not directly map to a numbered AC group — it's an infrastructure prerequisite for AC1 (append-only warm path). The design's Phase 3 "Done when" defines its own criteria:

- Agent loop passes full message array without system-role filtering for volatile content
- Scheduler uses `developer` role for injected context
- Model-switch and truncation markers use `developer`
- System prompt passed via `system` param contains only stable content (persona + orientation + skill body)
- All agent loop and context assembly tests pass

---

<!-- START_TASK_1 -->
### Task 1: Switch model-switch messages to `developer` role

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (line 945 — model-switch annotation)
- Modify: `packages/agent/src/agent-loop.ts` (lines 612, 617 — runtime model-switch on rate-limit fallback)

**Implementation:**

In `context-assembly.ts` at line 945, change the model-switch annotation from `system` to `developer`:

```typescript
annotated.push({
	role: "developer",  // was "system"
	content: `Model switched from ${lastAssistantModel} to ${m.model_id}`,
});
```

In `agent-loop.ts` at lines 612 and 617-618, change the runtime model-switch message:

```typescript
llmMessages.push({ role: "developer", content: switchMsg });  // was "system"
```

And the persisted message at line 617:

```typescript
const switchMsgId = insertThreadMessage(
	this.ctx.db,
	{
		threadId: this.config.threadId,
		role: "developer",  // was "system"
		content: switchMsg,
		hostOrigin: this.ctx.siteId,
	},
	this.ctx.siteId,
);
```

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: Model switch tests (lines 640-870) may need assertion updates for `developer` role

**Commit:** `refactor(agent): switch model-switch messages to developer role`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Switch truncation marker to `developer` role

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (line 1713 — truncation marker)

**Implementation:**

At line 1713, change the truncation marker role:

```typescript
truncationMarker.push({
	role: "developer",  // was "system"
	content: `[Context note: ${truncatedCount} earlier messages ...`,
});
```

**Verification:**
Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: Truncation tests (lines 1290-1418) may need assertion updates

**Commit:** `refactor(agent): switch truncation marker to developer role`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Switch scheduler messages to `developer` role

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/scheduler.ts` (lines 631, 726 — task wakeup and quiescence)

**Implementation:**

At line 631, change the task wakeup notification:

```typescript
insertRow(
	this.ctx.db,
	"messages",
	{
		// ...
		role: "developer",  // was "system"
		content: `[Task wakeup] Scheduled ${task.type} task ${task.id} triggered.`,
		// ...
	},
	this.ctx.siteId,
);
```

At line 726, change the quiescence note:

```typescript
insertRow(
	this.ctx.db,
	"messages",
	{
		// ...
		role: "developer",  // was "system"
		content: quiescenceNote,
		// ...
	},
	this.ctx.siteId,
);
```

**Verification:**
Run: `bun test packages/agent`
Expected: Scheduler tests pass (scheduler tests may not directly verify message roles)

**Commit:** `refactor(agent): switch scheduler messages to developer role`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Switch remaining volatile system messages to `developer` role

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (line 390 — compaction summary, line 537 — purge summary)
- Modify: `packages/agent/src/agent-loop.ts` (line 694 — turn cancellation notice)
- Modify: `packages/cli/src/commands/start/bootstrap.ts` (line 373 — interruption recovery)
- Modify: `packages/web/src/server/routes/status.ts` (lines 219, 241 — client/user cancellation)

**Implementation:**

Change all volatile/notification system messages to developer role. These are messages injected for the agent's awareness that are NOT part of the stable prompt.

In `context-assembly.ts`:
- Line 390 (compaction summary): `role: "developer"` (was `"system"`)
- Line 537 (purge summary): `role: "developer"` (was `"system"`)

In `agent-loop.ts`:
- Line 694 (turn cancellation): `role: "developer"` (was `"system"`)

In `bootstrap.ts`:
- Line 373 (interruption recovery): `role: "developer"` (was `"system"`)

In `status.ts`:
- Line 219 (client tool call cancellation): `role: "developer"` (was `"system"`)
- Line 241 (user cancellation): `role: "developer"` (was `"system"`)

**Important:** Do NOT change the stable prompt messages in context-assembly.ts:
- Line 1022 (default system prompt) — stays `system`
- Lines 1030-1035 (persona) — stays `system`
- Lines 1054-1057 (orientation) — stays `system`
- Lines 1102-1105 (skill body) — stays `system`

These stable messages are the ones the agent loop extracts for the `system` parameter.

**Verification:**
Run: `bun test packages/agent`
Expected: Some context assembly tests may need assertion updates for role changes

Run: `tsc -p packages/agent --noEmit && tsc -p packages/cli --noEmit && tsc -p packages/web --noEmit`
Expected: No type errors

**Commit:** `refactor(agent,cli,web): switch remaining volatile messages to developer role`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update all affected tests and verify driver compatibility

**Verifies:** All Phase 3 criteria

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts`
- Modify: `packages/agent/src/__tests__/agent-loop.test.ts`

**Testing:**

Update test assertions where messages were expected to have `role: "system"` but should now have `role: "developer"`:

- **Model switch tests** (context-assembly.test.ts lines 640-870): Change expected role from "system" to "developer" for model-switch annotations
- **Truncation tests** (context-assembly.test.ts lines 1290-1418): Change expected role for truncation markers
- **Compaction/purge tests**: Change expected role for compaction and purge summary messages
- **Agent loop tests** (agent-loop.test.ts): Update any assertions on message roles for model-switch, cancellation, etc.

Add verification tests:
- After assembleContext(), the only `system`-role messages in the result should be the stable prompt components (default prompt, persona, orientation, skill body)
- All volatile/per-turn messages should be `developer` role
- Verify driver compatibility: developer messages from Phase 1 are already handled (passed natively for OpenAI, mapped to system for Ollama). After this phase, no system-role messages reach the driver in the message array (they're all extracted by the agent loop). Run driver tests to confirm.

**Verification:**
Run: `bun test --recursive`
Expected: All tests pass, zero failures

Run: `bun run typecheck`
Expected: All packages typecheck clean

**Commit:** `test(agent): update tests for developer role migration`
<!-- END_TASK_5 -->
