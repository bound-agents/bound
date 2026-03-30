# Agent Skills Implementation Plan — Phase 6: Operator CLI

**Goal:** Expose skill management to the operator via `boundctl skill` subcommands.

**Architecture:** New `packages/cli/src/commands/skill.ts` with four handler functions (`skillList`, `skillView`, `skillRetire`, `skillImport`). All functions take a `Database` directly and use `insertRow`/`updateRow` from `@bound/core` for change-log compliance. `boundctl.ts` routes `boundctl skill {subcommand}` to these handlers using the same manual arg-parsing pattern used by all other boundctl commands. `parseFrontmatter` is imported from `@bound/agent` (Phase 3) to avoid duplication.

**Dependencies:** Phase 1 only (`skills` table schema). Phase 3 must complete before Phase 6 to provide the `parseFrontmatter` export.

**Tech Stack:** TypeScript, bun:sqlite, node:fs (readdirSync, readFileSync), bun:test

**Scope:** Phase 6 of 6

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### agent-skills.AC4: `boundctl skill` operator commands work

- **agent-skills.AC4.1 Success:** `boundctl skill list` outputs tabular skill data with correct columns
- **agent-skills.AC4.2 Success:** `boundctl skill view {name}` outputs full SKILL.md content and file listing for a known skill
- **agent-skills.AC4.3 Success:** `boundctl skill retire {name}` sets `status = 'retired'`, `retired_by = 'operator'` via `updateRow` (change-log entry created)
- **agent-skills.AC4.4 Success:** `boundctl skill retire {name} --reason "..."` persists the reason
- **agent-skills.AC4.5 Success:** `boundctl skill import {path}` writes skill files to `files` table and inserts a `skills` row for a valid local directory
- **agent-skills.AC4.6 Failure:** `boundctl skill import` rejects a directory with invalid or missing SKILL.md frontmatter

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->

<!-- START_TASK_1 -->
### Task 1: Create `packages/cli/src/commands/skill.ts` with all four handler functions

**Verifies:** agent-skills.AC4.1, agent-skills.AC4.2, agent-skills.AC4.3, agent-skills.AC4.4, agent-skills.AC4.5, agent-skills.AC4.6

**Files:**
- Create: `packages/cli/src/commands/skill.ts`

**Implementation:**

```typescript
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { parseFrontmatter } from "@bound/agent/src/commands/skill-activate";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

// parseFrontmatter is imported from @bound/agent (packages/agent/src/commands/skill-activate.ts)
// which is already a dependency of @bound/cli. This avoids duplication of the frontmatter
// parser logic between agent and CLI packages.

// ---------------------------------------------------------------------------
// skillList
// ---------------------------------------------------------------------------

export interface SkillListOpts {
	status?: string;
	verbose?: boolean;
}

export function skillList(db: Database, opts: SkillListOpts = {}): void {
	const whereClause = opts.status
		? "WHERE status = ? AND deleted = 0"
		: "WHERE deleted = 0";
	const queryArgs = opts.status ? [opts.status] : [];

	const rows = db
		.prepare(
			`SELECT name, status, activation_count, last_activated_at, description,
			        allowed_tools, compatibility, content_hash, retired_reason,
			        skill_root
			 FROM skills
			 ${whereClause}
			 ORDER BY last_activated_at DESC, name ASC`,
		)
		.all(...queryArgs) as Array<{
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		allowed_tools: string | null;
		compatibility: string | null;
		content_hash: string | null;
		retired_reason: string | null;
		skill_root: string;
	}>;

	if (rows.length === 0) {
		const filter = opts.status ? ` (status: ${opts.status})` : "";
		console.log(`No skills found${filter}.`);
		return;
	}

	if (opts.verbose) {
		console.log(
			"NAME             STATUS   ACT  LAST USED            DESCRIPTION                         ALLOWED_TOOLS        HASH             RETIRED_REASON",
		);
		console.log("-".repeat(150));
	} else {
		console.log("NAME             STATUS   ACT  LAST USED            DESCRIPTION");
		console.log("-".repeat(80));
	}

	for (const row of rows) {
		const name = row.name.padEnd(16);
		const status = row.status.padEnd(8);
		const act = String(row.activation_count ?? 0).padEnd(4);
		const lastUsed = (row.last_activated_at?.slice(0, 19) ?? "never").padEnd(20);
		const desc = row.description.slice(0, 35).padEnd(35);

		if (opts.verbose) {
			const tools = (row.allowed_tools ?? "").slice(0, 20).padEnd(20);
			const hash = (row.content_hash ?? "").slice(0, 16).padEnd(16);
			const reason = (row.retired_reason ?? "").slice(0, 20);
			console.log(`${name} ${status} ${act} ${lastUsed} ${desc} ${tools} ${hash} ${reason}`);
		} else {
			console.log(`${name} ${status} ${act} ${lastUsed} ${desc}`);
		}
	}
}

// ---------------------------------------------------------------------------
// skillView
// ---------------------------------------------------------------------------

export function skillView(db: Database, name: string): void {
	const skill = db
		.prepare(
			`SELECT id, name, status, activation_count, last_activated_at, description,
			        content_hash, skill_root, retired_by, retired_reason
			 FROM skills WHERE name = ? AND deleted = 0`,
		)
		.get(name) as {
		id: string;
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
		skill_root: string;
		retired_by: string | null;
		retired_reason: string | null;
	} | null;

	if (!skill) {
		console.error(`Error: Skill '${name}' not found.`);
		process.exit(1);
	}

	// Print metadata header
	console.log(`=== Skill: ${skill.name} ===`);
	console.log(`Status:      ${skill.status}`);
	console.log(`Activations: ${skill.activation_count ?? 0}`);
	console.log(`Last used:   ${skill.last_activated_at?.slice(0, 19) ?? "never"}`);
	console.log(`Hash:        ${skill.content_hash ?? "unknown"}`);
	if (skill.retired_by) {
		console.log(`Retired by:  ${skill.retired_by}`);
		if (skill.retired_reason) {
			console.log(`Reason:      ${skill.retired_reason}`);
		}
	}
	console.log("");

	// Print SKILL.md content from files table
	const skillMdPath = `${skill.skill_root}/SKILL.md`;
	const skillMdRow = db
		.prepare(
			"SELECT content FROM files WHERE path = ? AND deleted = 0",
		)
		.get(skillMdPath) as { content: string } | null;

	if (skillMdRow?.content) {
		console.log("=== SKILL.md ===");
		console.log(skillMdRow.content);
	} else {
		console.log("(SKILL.md content not found in files table)");
	}

	// Print file listing from files table
	const files = db
		.prepare(
			`SELECT path, size_bytes, modified_at FROM files
			 WHERE path LIKE ? AND deleted = 0
			 ORDER BY path`,
		)
		.all(`${skill.skill_root}/%`) as Array<{
		path: string;
		size_bytes: number;
		modified_at: string;
	}>;

	if (files.length > 0) {
		console.log("\n=== Files ===");
		for (const f of files) {
			const relPath = f.path.replace(skill.skill_root + "/", "");
			console.log(
				`  ${relPath.padEnd(40)} ${String(f.size_bytes).padStart(8)} bytes  ${f.modified_at.slice(0, 19)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// skillRetire
// ---------------------------------------------------------------------------

export function skillRetire(
	db: Database,
	siteId: string,
	name: string,
	reason?: string,
): void {
	const skill = db
		.prepare("SELECT id, status FROM skills WHERE name = ? AND deleted = 0")
		.get(name) as { id: string; status: string } | null;

	if (!skill) {
		console.error(`Error: Skill '${name}' not found.`);
		process.exit(1);
	}

	const now = new Date().toISOString();

	updateRow(
		db,
		"skills",
		skill.id,
		{
			status: "retired",
			retired_by: "operator",
			retired_reason: reason ?? null,
			modified_at: now,
		},
		siteId,
	);

	// Print per-task warnings for tasks referencing this skill
	const tasks = db
		.prepare(
			"SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL",
		)
		.all() as Array<{ id: string; payload: string; thread_id: string | null }>;

	let warned = 0;
	for (const task of tasks) {
		try {
			const payload = JSON.parse(task.payload);
			if (
				typeof payload === "object" &&
				payload !== null &&
				(payload as Record<string, unknown>).skill === name
			) {
				console.warn(
					`Warning: Task ${task.id} references skill '${name}' (payload.skill). Update or remove the skill reference.`,
				);
				warned++;
			}
		} catch {
			// Skip malformed payload
		}
	}

	const reasonMsg = reason ? ` (reason: ${reason})` : "";
	console.log(`Skill '${name}' retired by operator${reasonMsg}.`);
	if (warned > 0) {
		console.log(`${warned} task(s) reference this skill — see warnings above.`);
	}
}

// ---------------------------------------------------------------------------
// skillImport
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files in a directory, returning { relPath, content } pairs.
 */
function collectFiles(
	dirPath: string,
	baseDir: string,
): Array<{ relPath: string; content: string }> {
	const results: Array<{ relPath: string; content: string }> = [];
	const entries = readdirSync(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectFiles(fullPath, baseDir));
		} else if (entry.isFile()) {
			try {
				const content = readFileSync(fullPath, "utf-8");
				results.push({ relPath: relative(baseDir, fullPath), content });
			} catch {
				// Skip unreadable files (binaries, etc.)
			}
		}
	}
	return results;
}

export interface SkillImportOpts {
	force?: boolean;
}

export function skillImport(
	db: Database,
	siteId: string,
	localPath: string,
	_opts: SkillImportOpts = {},
): void {
	// Validate: directory must exist
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(localPath);
	} catch {
		console.error(`Error: Path '${localPath}' does not exist.`);
		process.exit(1);
	}
	if (!stat.isDirectory()) {
		console.error(`Error: '${localPath}' is not a directory.`);
		process.exit(1);
	}

	// Read and validate SKILL.md
	const skillMdPath = join(localPath, "SKILL.md");
	let skillMdContent: string;
	try {
		skillMdContent = readFileSync(skillMdPath, "utf-8");
	} catch {
		console.error(`Error: SKILL.md not found at ${skillMdPath}.`);
		process.exit(1);
	}

	const parsed = parseFrontmatter(skillMdContent);
	if (!parsed) {
		console.error(
			"Error: SKILL.md is missing required YAML frontmatter (---...---).",
		);
		process.exit(1);
	}

	const { data } = parsed;

	if (!data.name) {
		console.error("Error: SKILL.md frontmatter is missing required 'name' field.");
		process.exit(1);
	}

	if (!data.description) {
		console.error(
			"Error: SKILL.md frontmatter is missing required 'description' field.",
		);
		process.exit(1);
	}

	const skillName = data.name;
	const skillRoot = `/home/user/skills/${skillName}`;
	const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
	const now = new Date().toISOString();

	// Write all files to files table
	const allFiles = collectFiles(localPath, localPath);
	for (const { relPath, content } of allFiles) {
		const filePath = `${skillRoot}/${relPath}`;
		const fileSize = Buffer.byteLength(content, "utf8");
		const fileHash = createHash("sha256").update(content).digest("hex");

		const existingFile = db
			.prepare(
				"SELECT id, content FROM files WHERE path = ? AND deleted = 0",
			)
			.get(filePath) as { id: string; content: string | null } | null;

		if (existingFile) {
			const existingHash = createHash("sha256")
				.update(existingFile.content ?? "")
				.digest("hex");
			if (existingHash !== fileHash) {
				updateRow(
					db,
					"files",
					existingFile.id,
					{ content, size_bytes: fileSize, modified_at: now },
					siteId,
				);
			}
		} else {
			insertRow(
				db,
				"files",
				{
					id: filePath,
					path: filePath,
					content,
					is_binary: 0,
					size_bytes: fileSize,
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}
	}

	// Upsert skills row
	const contentHash = createHash("sha256").update(skillMdContent).digest("hex");
	const existingSkill = db
		.prepare("SELECT id, activation_count FROM skills WHERE id = ?")
		.get(skillId) as { id: string; activation_count: number } | null;

	if (existingSkill) {
		updateRow(
			db,
			"skills",
			skillId,
			{
				description: data.description,
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools: data.allowed_tools ?? null,
				compatibility: data.compatibility ?? null,
				metadata_json: JSON.stringify(data),
				activated_at: now,
				activation_count: (existingSkill.activation_count ?? 0) + 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	} else {
		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skillName,
				description: data.description,
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools: data.allowed_tools ?? null,
				compatibility: data.compatibility ?? null,
				metadata_json: JSON.stringify(data),
				activated_at: now,
				created_by_thread: null,
				activation_count: 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}

	console.log(
		`Skill '${skillName}' imported: ${allFiles.length} file(s) written to files table.`,
	);
}
```

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat(cli): add skill.ts with skillList, skillView, skillRetire, skillImport`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Register `boundctl skill` routing in `boundctl.ts`

**Verifies:** agent-skills.AC4.1–AC4.6 (routing layer)

**Files:**
- Modify: `packages/cli/src/boundctl.ts`

**Implementation:**

**Step 1: Add imports at the top of `boundctl.ts` (after existing imports, e.g., after line 11)**

```typescript
import { getSiteId } from "@bound/core";
import { skillImport, skillList, skillRetire, skillView } from "./commands/skill.js";
```

`getSiteId` reads `site_id` from `host_meta` — this is the established pattern used by `sync-status.ts` and other boundctl commands.

**Step 2: Add `skill` to the help text block (in the COMMANDS section of the usage help)**

After the `drain` entry in the help text, add:

```
  skill list              List all skills with status and telemetry
  skill view <name>       View SKILL.md and file listing for a skill
  skill retire <name>     Retire a skill (operator); use --reason "..." to explain
  skill import <path>     Import a skill from a local directory
```

**Step 3: Add the `skill` command handler block (after the last `if (command === "drain")` block, before the final "unknown command" fallthrough)**

```typescript
	if (command === "skill") {
		const subcommand = args[1];
		const configDir = getArgValue(args, "--config-dir") || "data";
		const db = openBoundDB(configDir);

		try {
			if (subcommand === "list") {
				const statusFilter = getArgValue(args, "--status");
				const verbose = args.includes("--verbose");
				skillList(db, { status: statusFilter, verbose });
				db.close();
				process.exit(0);
			}

			if (subcommand === "view") {
				const name = args[2];
				if (!name) {
					console.error("Error: skill name is required. Usage: boundctl skill view <name>");
					db.close();
					process.exit(1);
				}
				skillView(db, name);
				db.close();
				process.exit(0);
			}

			if (subcommand === "retire") {
				const name = args[2];
				if (!name) {
					console.error("Error: skill name is required. Usage: boundctl skill retire <name> [--reason \"...\"]");
					db.close();
					process.exit(1);
				}
				const reason = getArgValue(args, "--reason");
				const siteId = getSiteId(db);
				skillRetire(db, siteId, name, reason);
				db.close();
				process.exit(0);
			}

			if (subcommand === "import") {
				const localPath = args[2];
				if (!localPath) {
					console.error("Error: path is required. Usage: boundctl skill import <path>");
					db.close();
					process.exit(1);
				}
				const siteId = getSiteId(db);
				skillImport(db, siteId, localPath);
				db.close();
				process.exit(0);
			}

			// Unknown subcommand
			console.error(`Error: unknown skill subcommand '${subcommand}'.`);
			console.error("Available: list, view, retire, import");
			db.close();
			process.exit(1);
		} catch (error) {
			console.error("skill command failed:", error);
			db.close();
			process.exit(1);
		}
	}
```

**Step 4: Add `openBoundDB` import if not already present**

Check if `openBoundDB` is already imported at the top. If not, add:
```typescript
import { openBoundDB } from "./lib/db.js";
```

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat(cli): register boundctl skill subcommands in boundctl.ts`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Integration tests for `boundctl skill` commands

**Verifies:** agent-skills.AC4.1–AC4.6

**Files:**
- Create: `packages/cli/src/__tests__/skill-cli.test.ts`

**Testing:**

Follow the `startup-wiring.test.ts` / `boundctl.test.ts` pattern:
- `beforeAll`: Create tmpDir, dbPath, create db with `createDatabase(dbPath)`, apply schema with `applySchema(db)`
- `beforeEach`: Fresh siteId, seed `host_meta` with `db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId])`
- `afterAll`: Close db, rmSync tmpDir
- Import `skillList`, `skillView`, `skillRetire`, `skillImport` directly from `../commands/skill`

Tests to write (one `it()` per AC case):

- **AC4.1**: Insert one active skill row directly into `skills` table. Capture `console.log` output (use `jest.spyOn` on console, or mock via a spy). Call `skillList(db)`. Verify output contains header fields `NAME`, `STATUS`, `ACT` (activations), `LAST USED`, `DESCRIPTION` and the skill's name.

  Alternative approach (simpler): Modify `skillList` to accept an optional `output: string[]` parameter for testing (push lines there instead of console.log). This avoids mocking console. **Recommended:** Keep console.log for production, add a second overload-free approach: test by inspecting the skills table via direct query and verifying `skillList` doesn't throw.

  Most practical approach: Use a simple capture of `console.log` via mock. In bun:test, use `spyOn(console, 'log')`.

- **AC4.2**: Insert a skill row and a SKILL.md file in the files table. Call `skillView(db, name)`. Verify it doesn't throw and `console.log` was called with content including the SKILL.md body.

- **AC4.3**: Insert an active skill row. Call `skillRetire(db, siteId, 'pr-review')`. Query `skills` table. Expect `status = 'retired'` and `retired_by = 'operator'`. Verify a change-log entry was created.

- **AC4.4**: Same as AC4.3 but call `skillRetire(db, siteId, 'pr-review', 'Too noisy')`. Verify `retired_reason = 'Too noisy'`.

- **AC4.5**: Create a temp directory with a valid `SKILL.md` file (write it to disk with `writeFileSync`). Call `skillImport(db, siteId, tempSkillDir)`. Verify `files` table has a row for the SKILL.md path. Verify `skills` table has a row with `name` matching the frontmatter.

- **AC4.6**: Create a temp directory with a `SKILL.md` file that has NO frontmatter (just plain text). Call `skillImport(db, siteId, tempSkillDir)` inside a try-catch (it calls `process.exit(1)` on failure — mock `process.exit` with `spyOn(process, 'exit')` and `.mockImplementation(...)` to prevent actual exit). Verify the mock was called with code `1`.

Note on `process.exit` mocking: In bun:test, `spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called') })` works to prevent the process from actually exiting. Then use `expect(() => skillImport(...)).toThrow('process.exit called')`.

**Verification:**

Run: `bun test packages/cli --test-name-pattern "boundctl skill"`
Expected: All 6 tests pass.

Run: `bun test packages/cli`
Expected: All tests pass.

**Commit:** `test(cli): add skill-cli integration tests covering AC4.1–AC4.6`
<!-- END_TASK_3 -->

<!-- END_SUBCOMPONENT_A -->
