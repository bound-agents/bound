# Agent Skills Implementation Plan — Phase 4: Context Assembly Integration

**Goal:** Inject skill index, task skill body, and operator retirement notifications into assembled context.

**Architecture:** Three additions to Stage 6 (ASSEMBLY) in `context-assembly.ts`.

**Out of scope (not in design plan):**
- R-SK10: Posting a persistent system message to the user's system thread when an operator retires a skill. The design plan only specifies the 24-hour volatile context notification (AC3.6/AC3.7), which is the chosen approach. A persistent thread message would require additional infrastructure not covered here.
- R-SK12: Automatically updating `content_hash` in the `skills` table when FS_PERSIST detects modifications to files under an active skill's `skill_root`. The design plan does not include this requirement. Task skill body injection happens outside the `!noHistory` guard (so it works with `noHistory = true`). Skill index and operator retirement notifications go inside the `!noHistory` volatile context block, after the existing file-thread notification pattern. An `inactiveSkillRef` local variable bridges the task-skill check (outside `!noHistory`) with the volatile context note (inside `!noHistory`).

**Tech Stack:** TypeScript, bun:sqlite, bun:test

**Scope:** Phase 4 of 6

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### agent-skills.AC3: Context assembly injects skills correctly

- **agent-skills.AC3.1 Success:** When active skills exist, volatile context includes a `SKILLS (N active):` block with one `name — description` line per skill
- **agent-skills.AC3.2 Edge:** When no active skills exist, no SKILLS block appears in volatile context
- **agent-skills.AC3.3 Success:** When `ContextParams.taskId` is set and task payload has `"skill": "pr-review"` for an active skill, the assembled messages include a system message with the SKILL.md body before the history
- **agent-skills.AC3.4 Failure:** When the referenced skill is not active, a note `"Referenced skill 'pr-review' is not active."` appears in volatile context (no skill body injection)
- **agent-skills.AC3.5 Edge:** Task skill body injection works when `noHistory = true`
- **agent-skills.AC3.6 Success:** An operator retirement within the last 24 hours injects `[Skill notification] Skill '{name}' was retired by operator: "{reason}".` into volatile context
- **agent-skills.AC3.7 Edge:** An operator retirement older than 24 hours does not inject a notification

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Add three skill injections to Stage 6 in `context-assembly.ts`

**Verifies:** agent-skills.AC3.1, agent-skills.AC3.2, agent-skills.AC3.3, agent-skills.AC3.4, agent-skills.AC3.5, agent-skills.AC3.6, agent-skills.AC3.7

**Files:**
- Modify: `packages/agent/src/context-assembly.ts:535-626`

**Context (current lines around injection points):**

> **Note on line numbers:** Phase 3 Task 5 adds 4 entries to `AVAILABLE_COMMANDS` (currently at lines 76-92 of `context-assembly.ts`), shifting all subsequent line numbers by approximately 4. The line numbers below are for the codebase state at Phase 4 start (after Phase 3 Task 5 is complete). Use the semantic anchors (code content) rather than raw line numbers to locate the correct insertion points.

- Line ~538: `});` — closes orientation push
- Line ~539: (blank)
- Line ~540: `// Add message history`
- Line ~541: `assembled.push(...annotated);`
- Line ~543: `// Add volatile context at the end per spec R-U30`
- Line ~544: `if (!noHistory) {`
- Lines ~545-624: existing volatile context building
- Line ~625: (blank — end of file-thread notifications try-catch)
- Line ~626: `assembled.push({`  ← this is where volatileLines is pushed as a system message
- Line ~630: `}` — closes `!noHistory` block

**Implementation:**

**Insertion 1: Task skill body + `inactiveSkillRef` variable (after line 535, before line 536)**

Insert between the closing `});` of the orientation push (line 534) and the `// Add message history` comment (line 536):

```typescript
	// Track inactive skill reference for volatile context note (AC3.4)
	let inactiveSkillRef: string | null = null;

	// Inject task-referenced skill body as system message (AC3.3, AC3.5)
	// Must be outside the !noHistory guard so it works when noHistory = true
	if (taskId) {
		try {
			const taskRow = db
				.query("SELECT payload FROM tasks WHERE id = ? AND deleted = 0")
				.get(taskId) as { payload: string | null } | null;

			if (taskRow?.payload) {
				let taskPayload: unknown;
				try {
					taskPayload = JSON.parse(taskRow.payload);
				} catch {
					// Malformed payload — skip skill injection
				}

				if (
					typeof taskPayload === "object" &&
					taskPayload !== null &&
					"skill" in taskPayload &&
					typeof (taskPayload as Record<string, unknown>).skill === "string"
				) {
					const skillName = (taskPayload as Record<string, unknown>).skill as string;

					const skillRow = db
						.query(
							"SELECT id FROM skills WHERE name = ? AND status = 'active' AND deleted = 0",
						)
						.get(skillName) as { id: string } | null;

					if (skillRow) {
						const skillMdRow = db
							.query(
								"SELECT content FROM files WHERE path = ? AND deleted = 0",
							)
							.get(`/home/user/skills/${skillName}/SKILL.md`) as {
							content: string;
						} | null;

						if (skillMdRow?.content) {
							assembled.push({
								role: "system",
								content: skillMdRow.content,
							});
						}
					} else {
						// Skill referenced but not active — note will appear in volatile context
						inactiveSkillRef = skillName;
					}
				}
			}
		} catch {
			// Non-fatal: skip skill body injection on any error
		}
	}
```

**Insertion 2: Skill index + operator retirement notifications + inactive skill note (after line 620, inside the `!noHistory` block, before the `assembled.push({` that closes volatile context)**

Insert between the end of the file-thread notifications try-catch (line 620) and the `assembled.push({` call (line 622):

```typescript
		// Inject active skill index (AC3.1, AC3.2)
		try {
			const activeSkills = db
				.query(
					"SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC",
				)
				.all() as Array<{ name: string; description: string }>;

			if (activeSkills.length > 0) {
				volatileLines.push("");
				volatileLines.push(`SKILLS (${activeSkills.length} active):`);
				for (const s of activeSkills) {
					volatileLines.push(`  ${s.name} — ${s.description}`);
				}
			}
		} catch {
			// Non-fatal
		}

		// Inject operator retirement notifications (24h window) (AC3.6, AC3.7)
		try {
			const retiredByOperator = db
				.query(
					`SELECT name, retired_reason FROM skills
					 WHERE status = 'retired'
					   AND retired_by = 'operator'
					   AND modified_at > datetime('now', '-24 hours')
					   AND deleted = 0`,
				)
				.all() as Array<{ name: string; retired_reason: string | null }>;

			for (const s of retiredByOperator) {
				const reason = s.retired_reason ? `"${s.retired_reason}"` : "no reason given";
				volatileLines.push("");
				volatileLines.push(
					`[Skill notification] Skill '${s.name}' was retired by operator: ${reason}.`,
				);
			}
		} catch {
			// Non-fatal
		}

		// Inject inactive skill reference note (AC3.4)
		if (inactiveSkillRef) {
			volatileLines.push("");
			volatileLines.push(`Referenced skill '${inactiveSkillRef}' is not active.`);
		}
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:** `feat(agent): inject skill index, task skill body, and retirement notifications in context assembly`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for context assembly skill injections

**Verifies:** agent-skills.AC3.1–AC3.7

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts` (add new describe block at end of file)

**Testing:**

Add a `describe("skill context injection", ...)` block using the same test setup pattern as the existing tests (same `beforeAll` / `afterAll` database setup). Insert required skills/files data directly via `db.run()` for each test case.

Tests to write (one `it()` per AC case):

- **AC3.1**: Insert an active skill row directly into `skills` table. Call `assembleContext({ db, threadId, userId })`. Find the system message containing `SKILLS (1 active):`. Verify it includes `pr-review — Review GitHub PRs`.

- **AC3.2**: Ensure no skills exist in DB. Call `assembleContext(...)`. Verify no system message content contains `SKILLS (`.

- **AC3.3**: Insert an active `pr-review` skill into `skills` table. Insert the SKILL.md content into `files` table at path `/home/user/skills/pr-review/SKILL.md`. Insert a task with `payload = '{"skill":"pr-review"}'`. Call `assembleContext({ db, threadId, userId, taskId: task.id })`. Verify one system message contains the SKILL.md content (verify by checking for `name: pr-review` or similar frontmatter text from the file content). Verify this message appears BEFORE the message history.

- **AC3.4**: Insert a `pr-review` skill with `status = 'retired'`. Insert a task with `payload = '{"skill":"pr-review"}'`. Call `assembleContext({ ..., taskId: task.id })`. Verify NO system message contains SKILL.md content. Find the volatile context system message (the last one, after history). Verify it contains `Referenced skill 'pr-review' is not active.`.

- **AC3.5**: Same setup as AC3.3. Call `assembleContext({ ..., taskId: task.id, noHistory: true })`. Verify the skill body system message IS present in assembled messages despite `noHistory = true`.

- **AC3.6**: Insert a skill with `status = 'retired'`, `retired_by = 'operator'`, `retired_reason = 'Too aggressive'`, `modified_at = datetime('now', '-1 hour')` (recent). Call `assembleContext(...)`. Find the volatile context message. Verify it contains `[Skill notification] Skill 'deploy-monitor' was retired by operator: "Too aggressive".`.

- **AC3.7**: Same as AC3.6 but set `modified_at = datetime('now', '-25 hours')` (older than 24h). Verify the volatile context message does NOT contain `[Skill notification]`.

Helper for finding the volatile context system message: it's the last system message pushed into the assembled array (the one added inside `!noHistory`). You can find it by filtering `messages.filter(m => m.role === 'system')` and checking the last one.

**Verification:**

Run: `bun test packages/agent --test-name-pattern "skill context injection"`
Expected: All 7 tests pass.

Run: `bun test packages/agent`
Expected: All tests pass including existing context assembly tests (no regressions).

**Commit:** `test(agent): add context assembly skill injection tests covering AC3.1–AC3.7`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->
