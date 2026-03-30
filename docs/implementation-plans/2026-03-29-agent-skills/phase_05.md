# Agent Skills Implementation Plan — Phase 5: Startup Seeding

**Goal:** Ensure `skill-authoring` skill is always present (files + metadata) when the orchestrator starts.

**Architecture:** Extract seeding logic into a `seedSkillAuthoring(db, siteId)` helper function in a new file `packages/agent/src/seed-skills.ts`. `runStart()` in `start.ts` calls this function after user seeding (step 5, line 151) and before host registration. Seeding uses the `autoCacheFile` pattern from `cluster-fs.ts` for file writes (check path by hash, insert/update via change-log helpers) and the user-seeding pattern for the `skills` row (check existence by ID, `insertRow` only if missing — equivalent to `INSERT OR IGNORE` but change-log compliant).

**Tech Stack:** TypeScript, bun:sqlite, bun:test, node:crypto (createHash)

**Scope:** Phase 5 of 6

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### agent-skills.AC5: Bundled `skill-authoring` skill is always seeded

- **agent-skills.AC5.1 Success:** After first startup, `/home/user/skills/skill-authoring/SKILL.md` and `references/format-reference.md` exist in the `files` table
- **agent-skills.AC5.2 Success:** The `skills` table has an active `skill-authoring` row with the deterministic UUID after first startup
- **agent-skills.AC5.3 Edge:** If the operator retired `skill-authoring`, restarting leaves it retired (`INSERT OR IGNORE` does not override)
- **agent-skills.AC5.4 Edge:** If `skill-authoring` files are deleted from the `files` table, they are restored on next startup
- **agent-skills.AC5.5 Edge:** The content hash of seeded files matches the content in `bundled-skills.ts`

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Create `packages/agent/src/seed-skills.ts` with seeding helper

**Verifies:** agent-skills.AC5.1, agent-skills.AC5.2, agent-skills.AC5.3, agent-skills.AC5.4, agent-skills.AC5.5

**Files:**
- Create: `packages/agent/src/seed-skills.ts`

**Implementation:**

```typescript
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import {
	SKILL_AUTHORING_FORMAT_REFERENCE_MD,
	SKILL_AUTHORING_SKILL_MD,
} from "./bundled-skills";

/**
 * Seed a file into the files table if missing or stale (content hash differs).
 * Follows the autoCacheFile pattern from packages/sandbox/src/cluster-fs.ts.
 */
function seedFile(
	db: Database,
	siteId: string,
	path: string,
	content: string,
): void {
	const contentHash = createHash("sha256").update(content).digest("hex");
	const sizeBytes = Buffer.byteLength(content, "utf8");
	const now = new Date().toISOString();

	const existing = db
		.prepare(
			"SELECT id, content FROM files WHERE path = ? AND deleted = 0",
		)
		.get(path) as { id: string; content: string | null } | null;

	if (existing) {
		const existingHash = createHash("sha256")
			.update(existing.content ?? "")
			.digest("hex");
		if (existingHash !== contentHash) {
			// Content changed (e.g., updated bundled-skills.ts) — restore/update
			updateRow(
				db,
				"files",
				existing.id,
				{ content, size_bytes: sizeBytes, modified_at: now },
				siteId,
			);
		}
		// else: content unchanged, skip update (no-op)
	} else {
		// File missing (e.g., deleted from files table) — restore
		insertRow(
			db,
			"files",
			{
				id: path,
				path,
				content,
				is_binary: 0,
				size_bytes: sizeBytes,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
}

/**
 * Seed the bundled skill-authoring skill on startup.
 * Idempotent: safe to call on every boot.
 *
 * Behavior:
 * - Files: Always restores if missing or stale (AC5.1, AC5.4, AC5.5)
 * - Skills row: Only inserts if no row exists for skill-authoring ID.
 *   If operator retired skill-authoring, leaves it retired (AC5.3).
 */
export function seedSkillAuthoring(db: Database, siteId: string): void {
	const skillName = "skill-authoring";
	const skillRoot = `/home/user/skills/${skillName}`;
	const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
	const now = new Date().toISOString();

	// Step 1: Restore skill files if missing or stale (AC5.1, AC5.4, AC5.5)
	seedFile(db, siteId, `${skillRoot}/SKILL.md`, SKILL_AUTHORING_SKILL_MD);
	seedFile(
		db,
		siteId,
		`${skillRoot}/references/format-reference.md`,
		SKILL_AUTHORING_FORMAT_REFERENCE_MD,
	);

	// Step 2: Insert skills row only if it does not already exist (AC5.2, AC5.3)
	// Equivalent to INSERT OR IGNORE — change-log compliant version.
	const existing = db
		.prepare("SELECT id FROM skills WHERE id = ?")
		.get(skillId) as { id: string } | null;

	if (!existing) {
		const contentHash = createHash("sha256")
			.update(SKILL_AUTHORING_SKILL_MD)
			.digest("hex");

		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skillName,
				description:
					"Author, activate, and manage reusable instruction sets called skills.",
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools:
					"skill-activate skill-list skill-read skill-retire bash",
				compatibility: null,
				metadata_json: JSON.stringify({
					name: skillName,
					description:
						"Author, activate, and manage reusable instruction sets called skills.",
					allowed_tools:
						"skill-activate skill-list skill-read skill-retire bash",
				}),
				activated_at: now,
				created_by_thread: null,
				activation_count: 0,
				last_activated_at: null,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
	// If row already exists (active or operator-retired): leave unchanged.
}
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors. `seedSkillAuthoring` is exported and all imports resolve.

**Commit:** `feat(agent): add seedSkillAuthoring helper`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire `seedSkillAuthoring` into `runStart()` in `start.ts`

**Verifies:** agent-skills.AC5.1, agent-skills.AC5.2

**Files:**
- Modify: `packages/cli/src/commands/start.ts`

**Implementation:**

**Step 1: Add import at the top of `start.ts`**

Find the import block at the top of `packages/cli/src/commands/start.ts` (where `@bound/agent` imports are). Add:

```typescript
import { seedSkillAuthoring } from "@bound/agent/src/seed-skills";
```

(Or, depending on how `@bound/agent` exports its entry point, check if it needs to be exported via `packages/agent/src/index.ts` first. If `@bound/agent/src/seed-skills` is not accessible, export `seedSkillAuthoring` from `packages/agent/src/index.ts` and import it as `import { seedSkillAuthoring } from "@bound/agent"`.)

**Step 2: Export `seedSkillAuthoring` from `packages/agent/src/index.ts`**

Check `packages/agent/src/index.ts`. If it does not already export from `seed-skills.ts`, add:

```typescript
export { seedSkillAuthoring } from "./seed-skills";
```

**Step 3: Call `seedSkillAuthoring` after user seeding (after line 151, before `// 6. Host registration`)**

Insert after the closing `}` of the user seeding block (after line 151):

```typescript
	// 5.5. Skill-authoring seeding
	// Seeds the bundled skill-authoring skill into the files and skills tables.
	// Idempotent: safe to re-run on every boot.
	try {
		seedSkillAuthoring(appContext.db, appContext.siteId);
	} catch (error) {
		appContext.logger.warn(
			"[skills] Failed to seed skill-authoring skill",
			{ error: String(error) },
		);
	}
```

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No errors.

**Commit:** `feat(cli): wire seedSkillAuthoring into runStart`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for startup seeding (AC5.1–AC5.5)

**Verifies:** agent-skills.AC5.1, agent-skills.AC5.2, agent-skills.AC5.3, agent-skills.AC5.4, agent-skills.AC5.5

**Files:**
- Modify: `packages/cli/src/__tests__/startup-wiring.test.ts` (add new describe block)
  OR
- Create: `packages/agent/src/__tests__/seed-skills.test.ts`

**Recommendation:** Create a new test file `packages/agent/src/__tests__/seed-skills.test.ts` to test `seedSkillAuthoring` directly (faster, no need for full startup). This follows the pattern of testing at the function level.

**Testing:**

Follow the `packages/core/src/__tests__/schema.test.ts` setup pattern:
- `beforeEach`: Create temp db path with `randomBytes(4).toString("hex")`, create db, apply schema
- `afterEach`: Close db, unlink db file

Tests to write:

- **AC5.1**: Call `seedSkillAuthoring(db, siteId)`. Query `files` table for path `/home/user/skills/skill-authoring/SKILL.md`. Expect row to exist. Query for `/home/user/skills/skill-authoring/references/format-reference.md`. Expect row to exist.

- **AC5.2**: Call `seedSkillAuthoring(db, siteId)`. Query `skills` table for `name = 'skill-authoring'`. Expect row with `status = 'active'`. Verify `id` equals `deterministicUUID(BOUND_NAMESPACE, 'skill-authoring')`.

- **AC5.3**: Insert a `skills` row for `skill-authoring` with `status = 'retired'`, `retired_by = 'operator'` directly (via `insertRow`). Then call `seedSkillAuthoring(db, siteId)`. Re-query the skills row. Expect `status = 'retired'` (unchanged). Verify no duplicate rows exist.

- **AC5.4**: Call `seedSkillAuthoring(db, siteId)` once (creates files). Soft-delete the SKILL.md file row directly with `db.run("UPDATE files SET deleted = 1 WHERE path = ?", ...)`. Call `seedSkillAuthoring(db, siteId)` again. Expect the SKILL.md file row to exist again with `deleted = 0`.

- **AC5.5**: Call `seedSkillAuthoring(db, siteId)`. Query the files row for `/home/user/skills/skill-authoring/SKILL.md`. Compute SHA-256 of `SKILL_AUTHORING_SKILL_MD` from `bundled-skills.ts`. Verify the stored `content` matches (hash comparison or string equality).

**Note on AC5.4 soft-delete check:** In `seedFile`, the query uses `WHERE path = ? AND deleted = 0`. A soft-deleted row means the file is treated as missing, so `insertRow` creates a new row with `deleted = 0` at the same path. However, the unique index `idx_files_path ON files(path) WHERE deleted = 0` means only one non-deleted row can exist per path. The new insertRow should succeed because the deleted row doesn't conflict with the index.

**Verification:**

Run: `bun test packages/agent --test-name-pattern "seedSkillAuthoring"`
Expected: All 5 tests pass.

Run: `bun test packages/agent`
Expected: All tests pass.

**Commit:** `test(agent): add seedSkillAuthoring tests covering AC5.1–AC5.5`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
