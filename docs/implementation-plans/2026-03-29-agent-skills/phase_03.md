# Agent Skills Implementation Plan — Phase 3: Agent Commands

**Goal:** Implement all four skill management commands the agent uses.

**Architecture:** Four new `CommandDefinition` objects following the `memorize`/`forget` pattern. `skill-activate` uses `ctx.fs` for early file persistence (R-SK13). All commands use `insertRow`/`updateRow`/`softDelete` from `@bound/core` for the `skills` table. Advisory creation in `skill-retire` uses `insertRow(db, "advisories", ...)` directly (CLAUDE.md invariant: all synced-table writes must go through the change-log helpers). Note: existing `createAdvisory()` in `packages/agent/src/advisories.ts` uses raw SQL in violation of this invariant — do NOT use it.

**Tech Stack:** TypeScript, bun:sqlite, bun:test, just-bash (InMemoryFs for tests)

**Scope:** Phase 3 of 6

**Codebase verified:** 2026-03-29

---

## Acceptance Criteria Coverage

### agent-skills.AC2: Four agent commands behave correctly

- **agent-skills.AC2.1 Success:** `skill-activate pr-review` with valid SKILL.md in InMemoryFs inserts a `skills` row with `status = 'active'` and writes skill files to the `files` table
- **agent-skills.AC2.2 Success:** Skill files appear in the `files` table before the `skills` row is upserted (early persistence ordering)
- **agent-skills.AC2.3 Failure:** `skill-activate` with missing `SKILL.md` exits non-zero and makes no DB writes
- **agent-skills.AC2.4 Failure:** `skill-activate` with a `name` frontmatter field that doesn't match the directory name exits non-zero
- **agent-skills.AC2.5 Failure:** `skill-activate` with no `description` in frontmatter exits non-zero
- **agent-skills.AC2.6 Failure:** `skill-activate` when 20 skills are already active exits non-zero with a cap-exceeded message on stderr
- **agent-skills.AC2.7 Edge:** `skill-activate` on a previously retired skill transitions it back to `active` (upsert, no duplicate row)
- **agent-skills.AC2.8 Edge:** Skill ID is `deterministicUUID(BOUND_NAMESPACE, name)`; same name always produces the same UUID
- **agent-skills.AC2.9 Success:** `skill-list` outputs NAME / STATUS / ACTIVATIONS / LAST USED / DESCRIPTION columns
- **agent-skills.AC2.10 Success:** `skill-list --status retired` shows only retired skills
- **agent-skills.AC2.11 Success:** `skill-list --verbose` additionally shows `allowed_tools`, `compatibility`, `content_hash`, `retired_reason`
- **agent-skills.AC2.12 Success:** `skill-read pr-review` outputs the SKILL.md content with a status/telemetry header
- **agent-skills.AC2.13 Failure:** `skill-read unknown-skill` exits non-zero
- **agent-skills.AC2.14 Success:** `skill-retire pr-review` sets `status = 'retired'`, `retired_by = 'agent'`
- **agent-skills.AC2.15 Success:** `skill-retire pr-review --reason "..."` persists `retired_reason`
- **agent-skills.AC2.16 Success:** `skill-retire` scans `tasks` for payloads containing `"skill": "pr-review"` and creates one advisory per matching task

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: Implement `skill-activate` command

**Verifies:** agent-skills.AC2.1, agent-skills.AC2.2, agent-skills.AC2.3, agent-skills.AC2.4, agent-skills.AC2.5, agent-skills.AC2.6, agent-skills.AC2.7, agent-skills.AC2.8

**Files:**
- Create: `packages/agent/src/commands/skill-activate.ts`

**Implementation:**

```typescript
import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

const MAX_ACTIVE_SKILLS = 20;
const MAX_SKILL_BODY_LINES = 500;
const MAX_FILE_SIZE_BYTES = 64 * 1024; // 64 KB
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;

// Out of scope (not in design plan, deferred):
// - R-SK12: FS_PERSIST content_hash update when files are modified post-activation
// - R-SK15: Namespace collision check against built-in command names / MCP server names
// - R-SK15: Directory total size limit (500 KB) -- deferred per design plan
// - R-SK15: allowed_tools validation warning -- deferred per design plan

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Exported so packages/cli/src/commands/skill.ts can import it (DRY).
 */
export function parseFrontmatter(
	content: string,
): { data: Record<string, string>; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) return null;
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			data[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
		}
	}
	return { data, body: match[2] ?? "" };
}

export const skillActivate: CommandDefinition = {
	name: "skill-activate",
	args: [
		{
			name: "name",
			required: true,
			description: "Skill directory name under /home/user/skills/",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			if (!ctx.fs) {
				return commandError("Filesystem unavailable: ctx.fs is not set");
			}

			const name = args.name;
			const skillRoot = `/home/user/skills/${name}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;

			// Validate skill name format (S6.1)
			if (!SKILL_NAME_REGEX.test(name)) {
				return commandError(
					`Invalid skill name '${name}': must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric, hyphens allowed between segments)\n`,
				);
			}
			if (name.length > MAX_SKILL_NAME_LENGTH) {
				return commandError(
					`Skill name '${name}' exceeds maximum length of ${MAX_SKILL_NAME_LENGTH} characters\n`,
				);
			}

			// Read SKILL.md
			let content: string;
			try {
				content = await ctx.fs.readFile(skillMdPath);
			} catch {
				return commandError(
					`Skill '${name}' not found: missing ${skillMdPath}\n`,
				);
			}

			// Validate file size
			const sizeBytes = Buffer.byteLength(content, "utf8");
			if (sizeBytes > MAX_FILE_SIZE_BYTES) {
				return commandError(
					`SKILL.md exceeds 64 KB size limit (${sizeBytes} bytes)\n`,
				);
			}

			// Parse frontmatter
			const parsed = parseFrontmatter(content);
			if (!parsed) {
				return commandError(
					"SKILL.md is missing required YAML frontmatter (---...---)\n",
				);
			}

			const { data, body } = parsed;

			// Validate name matches directory
			if (data.name && data.name !== name) {
				return commandError(
					`Frontmatter 'name' field ('${data.name}') does not match directory name ('${name}')\n`,
				);
			}

			// Validate description is present and within length limit (S6.1)
			if (!data.description) {
				return commandError(
					"SKILL.md is missing required 'description' field in frontmatter\n",
				);
			}
			if (data.description.length > MAX_DESCRIPTION_LENGTH) {
				return commandError(
					`Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${data.description.length} chars)\n`,
				);
			}

			// Validate body line count
			const bodyLines = body.split("\n").length;
			if (bodyLines > MAX_SKILL_BODY_LINES) {
				return commandError(
					`SKILL.md body exceeds ${MAX_SKILL_BODY_LINES} lines (${bodyLines} lines)\n`,
				);
			}

			// Check active skill cap — do not count the skill being (re-)activated itself
			const skillId = deterministicUUID(BOUND_NAMESPACE, name);
			const capRow = ctx.db
				.prepare(
					"SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0 AND id != ?",
				)
				.get(skillId) as { count: number };
			if (capRow.count >= MAX_ACTIVE_SKILLS) {
				return commandError(
					`Active skill cap reached (${MAX_ACTIVE_SKILLS} maximum). Retire a skill before activating another.\n`,
				);
			}

			const now = new Date().toISOString();

			// R-SK13: Early file persistence — write all skill files to files table BEFORE upserting skills row
			const allPaths = ctx.fs
				.getAllPaths()
				.filter((p) => p.startsWith(skillRoot + "/"));
			for (const filePath of allPaths) {
				let fileContent: string;
				try {
					fileContent = await ctx.fs.readFile(filePath);
				} catch {
					continue; // skip unreadable entries (e.g., directories)
				}
				const fileSize = Buffer.byteLength(fileContent, "utf8");
				const fileHash = createHash("sha256").update(fileContent).digest("hex");

				const existingFile = ctx.db
					.prepare(
						"SELECT id, content FROM files WHERE path = ? AND deleted = 0",
					)
					.get(filePath) as { id: string; content: string } | null;

				if (existingFile) {
					const existingHash = createHash("sha256")
						.update(existingFile.content ?? "")
						.digest("hex");
					if (existingHash !== fileHash) {
						updateRow(
							ctx.db,
							"files",
							existingFile.id,
							{ content: fileContent, size_bytes: fileSize, modified_at: now },
							ctx.siteId,
						);
					}
				} else {
					insertRow(
						ctx.db,
						"files",
						{
							id: filePath,
							path: filePath,
							content: fileContent,
							is_binary: 0,
							size_bytes: fileSize,
							created_at: now,
							modified_at: now,
							deleted: 0,
						},
						ctx.siteId,
					);
				}
			}

			// Upsert skills row — after files are persisted
			const contentHash = createHash("sha256").update(content).digest("hex");
			const existing = ctx.db
				.prepare("SELECT id, activation_count FROM skills WHERE id = ?")
				.get(skillId) as { id: string; activation_count: number } | null;

			if (existing) {
				updateRow(
					ctx.db,
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
						activation_count: (existing.activation_count ?? 0) + 1,
						last_activated_at: now,
						retired_by: null,
						retired_reason: null,
						modified_at: now,
						deleted: 0,
					},
					ctx.siteId,
				);
			} else {
				insertRow(
					ctx.db,
					"skills",
					{
						id: skillId,
						name,
						description: data.description,
						status: "active",
						skill_root: skillRoot,
						content_hash: contentHash,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						metadata_json: JSON.stringify(data),
						activated_at: now,
						created_by_thread: ctx.threadId ?? null,
						activation_count: 1,
						last_activated_at: now,
						retired_by: null,
						retired_reason: null,
						modified_at: now,
						deleted: 0,
					},
					ctx.siteId,
				);
			}

			return commandSuccess(`Skill '${name}' activated successfully.\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat(agent): implement skill-activate command`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Implement `skill-list` command

**Verifies:** agent-skills.AC2.9, agent-skills.AC2.10, agent-skills.AC2.11

**Files:**
- Create: `packages/agent/src/commands/skill-list.ts`

**Implementation:**

```typescript
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandSuccess, handleCommandError } from "./helpers";

export const skillList: CommandDefinition = {
	name: "skill-list",
	args: [
		{
			name: "status",
			required: false,
			description: "Filter by status: 'active' or 'retired'",
		},
		{
			name: "verbose",
			required: false,
			description: "Show additional columns (allowed_tools, compatibility, content_hash, retired_reason)",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const statusFilter = args.status;
			// Boolean flag convention: present = true, absent = false (consistent with forget's --prefix)
			const verbose = args.verbose !== undefined;

			const whereClause = statusFilter
				? "WHERE status = ? AND deleted = 0"
				: "WHERE deleted = 0";
			const queryArgs = statusFilter ? [statusFilter] : [];

			const rows = ctx.db
				.prepare(
					`SELECT name, status, activation_count, last_activated_at, description,
					        allowed_tools, compatibility, content_hash, retired_reason
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
			}>;

			if (rows.length === 0) {
				const filter = statusFilter ? ` (status: ${statusFilter})` : "";
				return commandSuccess(`No skills found${filter}.\n`);
			}

			const lines: string[] = [];

			// Header
			if (verbose) {
				lines.push(
					"NAME             STATUS   ACTIVATIONS LAST USED            DESCRIPTION                         ALLOWED_TOOLS        CONTENT_HASH     RETIRED_REASON",
				);
				lines.push("-".repeat(160));
			} else {
				lines.push(
					"NAME             STATUS   ACTIVATIONS LAST USED            DESCRIPTION",
				);
				lines.push("-".repeat(90));
			}

			for (const row of rows) {
				const name = row.name.padEnd(16);
				const status = row.status.padEnd(8);
				const activations = String(row.activation_count ?? 0).padEnd(11);
				const lastUsed = (row.last_activated_at?.slice(0, 19) ?? "never").padEnd(20);
				const desc = row.description.slice(0, 35).padEnd(35);

				if (verbose) {
					const tools = (row.allowed_tools ?? "").slice(0, 20).padEnd(20);
					const hash = (row.content_hash ?? "").slice(0, 16).padEnd(16);
					const reason = (row.retired_reason ?? "").slice(0, 20);
					lines.push(
						`${name} ${status} ${activations} ${lastUsed} ${desc} ${tools} ${hash} ${reason}`,
					);
				} else {
					lines.push(`${name} ${status} ${activations} ${lastUsed} ${desc}`);
				}
			}

			return commandSuccess(lines.join("\n") + "\n");
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:** `feat(agent): implement skill-list command`
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 3-4) -->

<!-- START_TASK_3 -->
### Task 3: Implement `skill-read` command

**Verifies:** agent-skills.AC2.12, agent-skills.AC2.13

**Files:**
- Create: `packages/agent/src/commands/skill-read.ts`

**Implementation:**

```typescript
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const skillRead: CommandDefinition = {
	name: "skill-read",
	args: [
		{
			name: "name",
			required: true,
			description: "Name of the skill to read",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const name = args.name;
			const skillMdPath = `/home/user/skills/${name}/SKILL.md`;

			// Get skill metadata
			const skill = ctx.db
				.prepare(
					"SELECT id, name, status, activation_count, last_activated_at, description, content_hash FROM skills WHERE name = ? AND deleted = 0",
				)
				.get(name) as {
				id: string;
				name: string;
				status: string;
				activation_count: number;
				last_activated_at: string | null;
				description: string;
				content_hash: string | null;
			} | null;

			if (!skill) {
				return commandError(`Skill '${name}' not found.`);
			}

			// Read SKILL.md content from files table
			const fileRow = ctx.db
				.prepare(
					"SELECT content FROM files WHERE path = ? AND deleted = 0",
				)
				.get(skillMdPath) as { content: string } | null;

			const skillMdContent = fileRow?.content ?? "(SKILL.md content not found in files table)";

			const header = [
				`--- Skill: ${skill.name} ---`,
				`Status:      ${skill.status}`,
				`Activations: ${skill.activation_count ?? 0}`,
				`Last used:   ${skill.last_activated_at?.slice(0, 19) ?? "never"}`,
				`Hash:        ${skill.content_hash ?? "unknown"}`,
				"",
			].join("\n");

			return commandSuccess(header + skillMdContent + "\n");
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:** `feat(agent): implement skill-read command`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Implement `skill-retire` command

**Verifies:** agent-skills.AC2.14, agent-skills.AC2.15, agent-skills.AC2.16

**Files:**
- Create: `packages/agent/src/commands/skill-retire.ts`

**Important:** Advisory creation uses `insertRow(db, "advisories", ...)` directly — NOT the existing `createAdvisory()` helper in `advisories.ts`, which uses raw SQL and violates the change-log outbox invariant from CLAUDE.md.

**Implementation:**

```typescript
import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const skillRetire: CommandDefinition = {
	name: "skill-retire",
	args: [
		{
			name: "name",
			required: true,
			description: "Name of the skill to retire",
		},
		{
			name: "reason",
			required: false,
			description: "Reason for retiring the skill",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const name = args.name;
			const reason = args.reason ?? null;

			// Find the skill
			const skill = ctx.db
				.prepare(
					"SELECT id, status FROM skills WHERE name = ? AND deleted = 0",
				)
				.get(name) as { id: string; status: string } | null;

			if (!skill) {
				return commandError(`Skill '${name}' not found.`);
			}

			const now = new Date().toISOString();

			// Retire the skill
			updateRow(
				ctx.db,
				"skills",
				skill.id,
				{
					status: "retired",
					retired_by: "agent",
					retired_reason: reason,
					modified_at: now,
				},
				ctx.siteId,
			);

			// Scan tasks for payloads referencing this skill and create advisories
			const tasks = ctx.db
				.prepare(
					"SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL",
				)
				.all() as Array<{ id: string; payload: string; thread_id: string | null }>;

			let advisoryCount = 0;
			for (const task of tasks) {
				let payload: unknown;
				try {
					payload = JSON.parse(task.payload);
				} catch {
					continue;
				}
				if (
					typeof payload === "object" &&
					payload !== null &&
					"skill" in payload &&
					(payload as Record<string, unknown>).skill === name
				) {
					const advisoryId = randomUUID();
					insertRow(
						ctx.db,
						"advisories",
						{
							id: advisoryId,
							type: "general",
							status: "proposed",
							title: `Skill '${name}' was retired`,
							detail: `Task ${task.id} references skill '${name}' which was retired by agent${reason ? `: ${reason}` : ""}.`,
							action: `Update task ${task.id} to use a different skill or remove the skill reference.`,
							impact: null,
							evidence: JSON.stringify({ task_id: task.id, skill: name }),
							proposed_at: now,
							defer_until: null,
							resolved_at: null,
							created_by: ctx.siteId,
							modified_at: now,
							deleted: 0,
						},
						ctx.siteId,
					);
					advisoryCount++;
				}
			}

			const msg = reason
				? `Skill '${name}' retired. Reason: ${reason}.\n`
				: `Skill '${name}' retired.\n`;
			const advisoryMsg =
				advisoryCount > 0
					? `${advisoryCount} advisory${advisoryCount === 1 ? "" : "s"} created for referencing tasks.\n`
					: "";
			return commandSuccess(msg + advisoryMsg);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

**Commit:** `feat(agent): implement skill-retire command`
<!-- END_TASK_4 -->

<!-- END_SUBCOMPONENT_B -->

<!-- START_SUBCOMPONENT_C (tasks 5-6) -->

<!-- START_TASK_5 -->
### Task 5: Register commands in `index.ts` and `context-assembly.ts`

**Verifies:** None (infrastructure)

**Files:**
- Modify: `packages/agent/src/commands/index.ts`
- Modify: `packages/agent/src/context-assembly.ts:76-92`

**Implementation:**

**Step 1: Add imports to `packages/agent/src/commands/index.ts`**

Add the following imports after the existing imports (before the `getAllCommands` function):

```typescript
import { skillActivate } from "./skill-activate";
import { skillList } from "./skill-list";
import { skillRead } from "./skill-read";
import { skillRetire } from "./skill-retire";
```

Then add the four commands to the `getAllCommands()` return array:

```typescript
export function getAllCommands(): CommandDefinition[] {
	return [
		help,
		query,
		memorize,
		forget,
		schedule,
		cancel,
		emit,
		purge,
		awaitCmd,
		cacheWarm,
		cachePin,
		cacheUnpin,
		cacheEvict,
		modelHint,
		archive,
		hostinfo,
		skillActivate,
		skillList,
		skillRead,
		skillRetire,
	];
}
```

**Step 2: Add four entries to `AVAILABLE_COMMANDS` in `packages/agent/src/context-assembly.ts` (lines 76-92)**

Append four entries before the `] as const;` closing:

```typescript
{ name: "skill-activate", description: "Activate a skill from /home/user/skills/{name}/SKILL.md" },
{ name: "skill-list", description: "List skills with status, activations, and description" },
{ name: "skill-read", description: "Read a skill's SKILL.md content with status header" },
{ name: "skill-retire", description: "Retire a skill; scans tasks and creates advisories" },
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No errors.

Run: `bun test packages/agent`
Expected: All existing tests still pass.

**Commit:** `feat(agent): register skill commands in getAllCommands and AVAILABLE_COMMANDS`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Tests for all four skill commands

**Verifies:** agent-skills.AC2.1–AC2.16

**Files:**
- Create: `packages/agent/src/__tests__/skill-commands.test.ts`

**Testing:**

Follow the `commands.test.ts` setup pattern (beforeAll, single shared db, ctx typed as `CommandContext`). The `ctx.fs` field must be set using `InMemoryFs` from `just-bash`.

If `import { InMemoryFs } from "just-bash"` fails with module not found, add `"just-bash": "*"` to the `devDependencies` of `packages/agent/package.json`.

Test setup pattern:
```typescript
import { InMemoryFs } from "just-bash";
// ctx setup follows the existing commands.test.ts pattern but adds fs:
const inMemoryFs = new InMemoryFs();
ctx = {
	db, siteId, eventBus, logger,
	threadId: randomUUID(),
	taskId: randomUUID(),
	fs: inMemoryFs,
};
// Reset InMemoryFs between tests that need clean state
```

Tests to write (one `it()` per AC case):

- **AC2.1**: Write valid SKILL.md to InMemoryFs at `/home/user/skills/pr-review/SKILL.md`, call `skill-activate pr-review`. Expect `exitCode === 0`. Query `skills` table: row with `name = 'pr-review'` and `status = 'active'`. Query `files` table: row at path `/home/user/skills/pr-review/SKILL.md`.

- **AC2.2**: Same setup as AC2.1 but intercept — verify `files` row appears at the right ordering. Since tests are synchronous, this is verified by confirming both rows exist after the call. To test ordering, use a modified version of `skill-activate` — or just verify that if skill file appears in `files` after the call, the invariant holds (acceptable: test that skill file IS in `files` table when skills row exists).

- **AC2.3**: Do NOT write SKILL.md to InMemoryFs. Call `skill-activate missing-skill`. Expect `exitCode !== 0`. Verify no row in `skills` and no row in `files` for that path.

- **AC2.4**: Write SKILL.md with frontmatter `name: wrong-name` but activate as `pr-review`. Expect `exitCode !== 0`.

- **AC2.5**: Write SKILL.md with frontmatter missing `description`. Expect `exitCode !== 0`.

- **AC2.6**: Pre-insert 20 active skills directly into the `skills` table (raw INSERT). Then try to activate a 21st skill. Expect `exitCode !== 0` and `stderr` contains cap-exceeded message.

- **AC2.7**: Write SKILL.md, activate skill, then retire it directly (`updateRow`). Re-activate with `skill-activate`. Expect `exitCode === 0` and `status = 'active'`. Verify only one row in `skills` for that name.

- **AC2.8**: Call `skillActivate` twice with the same name. Verify the `id` field in `skills` equals `deterministicUUID(BOUND_NAMESPACE, 'pr-review')` and there is only one row.

- **AC2.9**: Insert a skills row directly, call `skill-list`. Expect `exitCode === 0` and `stdout` contains the column header `NAME`, `STATUS`, `ACTIVATIONS`, `LAST USED`, `DESCRIPTION`.

- **AC2.10**: Insert one active and one retired skill. Call `skill-list --status retired`. Verify only the retired skill appears in stdout.

- **AC2.11**: Call `skill-list --verbose`. Verify stdout contains `ALLOWED_TOOLS`, `CONTENT_HASH`, `RETIRED_REASON`.

- **AC2.12**: Activate a skill (inserts SKILL.md to files table). Call `skill-read pr-review`. Expect `exitCode === 0` and stdout contains the header fields (Status, Activations, Hash) AND the SKILL.md content.

- **AC2.13**: Call `skill-read unknown-skill`. Expect `exitCode !== 0`.

- **AC2.14**: Activate a skill. Call `skill-retire pr-review`. Expect `exitCode === 0`. Query `skills`: `status = 'retired'`, `retired_by = 'agent'`.

- **AC2.15**: Call `skill-retire pr-review --reason "Too noisy"`. Query `skills`: `retired_reason = 'Too noisy'`.

- **AC2.16**: Insert a task with `payload = '{"skill":"pr-review","other":"data"}'`. Activate then retire `pr-review`. Verify one advisory in `advisories` table with `title` containing `pr-review`.

**Verification:**

Run: `bun test packages/agent`
Expected: All tests pass including the new skill-commands.test.ts.

Run: `bun test packages/agent --test-name-pattern "skill"`
Expected: All 16 skill-command tests pass.

**Commit:** `test(agent): add skill-commands tests covering AC2.1–AC2.16`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_C -->
