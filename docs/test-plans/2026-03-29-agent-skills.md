# Test Plan: Agent Skills (2026-03-29)

## Prerequisites

- Environment: Local development machine with Bun 1.3+ installed
- Database: Fresh instance (run `bun packages/cli/src/bound.ts init` to create config directory and database)
- All automated tests passing: `bun test --recursive` (exits 0)
- Typecheck passing: `bun run typecheck` (exits 0)
- Working directory: project root

## Automated Coverage

All 34 acceptance criteria are verified by automated tests:

| Test File | Criteria | Count |
|-----------|----------|-------|
| `packages/core/src/__tests__/schema.test.ts` | AC1.1, AC1.3, AC1.4, AC1.5 | 4 |
| `packages/shared/src/types.ts` (compile-time) | AC1.2 | 1 |
| `packages/agent/src/__tests__/skill-commands.test.ts` | AC2.1–AC2.16 | 16 |
| `packages/agent/src/__tests__/context-assembly.test.ts` | AC3.1–AC3.7 | 7 |
| `packages/agent/src/__tests__/seed-skills.test.ts` | AC5.1–AC5.5 | 5 |
| `packages/cli/src/__tests__/skill-cli.test.ts` | AC4.1–AC4.6 | 6 |

Run: `bun test --recursive` — expect exit code 0.

---

## Phase 1: Schema Integrity (End-to-End)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Start the application with a fresh database: `bun packages/cli/src/bound.ts start`. Stop it (Ctrl+C). Open the database: `sqlite3 data/bound.db` and run `PRAGMA table_info(skills);` | All 17 columns listed: id, name, description, status, skill_root, content_hash, allowed_tools, compatibility, metadata_json, activated_at, created_by_thread, activation_count, last_activated_at, retired_by, retired_reason, modified_at, deleted. |
| 1.2 | In the same session, run `.schema skills` | Table is created with `STRICT` keyword. The `CREATE UNIQUE INDEX idx_skills_name` statement is present on `(name) WHERE deleted = 0`. |
| 1.3 | Run `SELECT * FROM skills WHERE name = 'skill-authoring' AND deleted = 0;` | Exactly one row exists with `status = 'active'`. Verifies AC5.1/AC5.2 at the integration level. |

---

## Phase 2: Bundled Skill Seeding (Startup Behavior)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | With the database from Phase 1, run `SELECT path FROM files WHERE path LIKE '/home/user/skills/skill-authoring/%' AND deleted = 0;` | Two rows: `/home/user/skills/skill-authoring/SKILL.md` and `/home/user/skills/skill-authoring/references/format-reference.md`. |
| 2.2 | Run `UPDATE files SET deleted = 1 WHERE path = '/home/user/skills/skill-authoring/SKILL.md';`. Start and stop the application. Query `SELECT deleted FROM files WHERE path = '/home/user/skills/skill-authoring/SKILL.md';` | `deleted = 0` — the file was restored by startup seeding (AC5.4). |
| 2.3 | Run `UPDATE skills SET status = 'retired', retired_by = 'operator' WHERE name = 'skill-authoring';`. Start/stop the application. Query `SELECT status, retired_by FROM skills WHERE name = 'skill-authoring';` | `status = 'retired'`, `retired_by = 'operator'` — operator retirement is not overridden on restart (AC5.3). |

---

## Phase 3: Agent Skill Commands (via Web UI)

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Start the application. Open the web UI. Send: "List all skills." | The agent executes `skill-list`. Response includes a formatted table showing `skill-authoring` with status `active`. |
| 3.2 | Send: "Read the skill-authoring skill for me." | The agent executes `skill-read skill-authoring`. Response includes the telemetry header (Status, Activations, Hash) and the SKILL.md body. |
| 3.3 | Send: "Retire the skill-authoring skill with reason 'Testing retirement'." | The agent executes `skill-retire`. Query: `SELECT status, retired_by, retired_reason FROM skills WHERE name = 'skill-authoring'` shows `retired`, `agent`, `Testing retirement`. |
| 3.4 | Send: "Re-activate the skill-authoring skill." (After re-creating SKILL.md in the virtual filesystem.) | The agent executes `skill-activate skill-authoring`. Query: `SELECT status, activation_count FROM skills WHERE name = 'skill-authoring'` shows `active` with incremented count. |

---

## Phase 4: Context Assembly Verification

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Ensure skill-authoring is active. Start a new thread. Send: "What skills do you have available?" | The agent's response references `skill-authoring` by name — evidence the SKILLS block was injected into volatile context (AC3.1). |
| 4.2 | Retire skill-authoring as operator directly: `UPDATE skills SET status = 'retired', retired_by = 'operator', retired_reason = 'E2E test', modified_at = datetime('now') WHERE name = 'skill-authoring';`. Start a new thread and send any message. Then ask: "Were any skills recently retired?" | The agent mentions the operator retirement notification (AC3.6). |
| 4.3 | Set `modified_at` to 25 hours ago: `UPDATE skills SET modified_at = datetime('now', '-25 hours') WHERE name = 'skill-authoring';`. Start a new thread and ask: "Were any skills recently retired?" | The agent does NOT mention the old retirement notification — the 24h window has expired (AC3.7). |

---

## Phase 5: Operator CLI Commands (boundctl)

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | `bun packages/cli/src/bound.ts ctl skill list` | Tabular output with columns NAME, STATUS, ACT, LAST USED, DESCRIPTION. The `skill-authoring` row is visible. |
| 5.2 | `bun packages/cli/src/bound.ts ctl skill view skill-authoring` | Output includes metadata header (`=== Skill: skill-authoring ===`), full SKILL.md content, and file listing showing SKILL.md and references/format-reference.md. |
| 5.3 | `bun packages/cli/src/bound.ts ctl skill retire skill-authoring --reason "Operator test"` | Success message. DB query: `SELECT status, retired_by, retired_reason FROM skills WHERE name = 'skill-authoring'` shows `retired`, `operator`, `Operator test`. |
| 5.4 | Create `/tmp/test-skill/SKILL.md` with frontmatter `name: test-import` and `description: An imported skill`. Run: `bun packages/cli/src/bound.ts ctl skill import /tmp/test-skill` | Success message. DB query confirms `skills` row with `name = 'test-import'`, `status = 'active'`, and corresponding `files` entries. |
| 5.5 | Create `/tmp/bad-skill/SKILL.md` with no YAML frontmatter. Run: `bun packages/cli/src/bound.ts ctl skill import /tmp/bad-skill` | Process exits with code 1. Error message about missing/invalid frontmatter printed to stderr (AC4.6). |

---

## End-to-End: Full Skill Lifecycle

1. Start with a fresh database. Verify `skill-authoring` seeded (1 active skill row, 2 file rows).
2. Via the web UI, ask the agent to create a new skill by writing a SKILL.md file and activating it.
3. Verify the new skill appears in `skill-list` output (via agent or CLI).
4. Create a task with `payload = '{"skill":"<new-skill-name>"}'` in the database. Start a new thread with that `taskId`. Verify the SKILL.md body appears in the agent's context (skill instructions visible in its response).
5. Retire the skill via `skill-retire` (agent command). Verify advisories were created for tasks referencing it.
6. Verify the skill no longer appears in the active SKILLS block of volatile context.
7. Re-activate the skill. Verify `activation_count` incremented and only 1 row exists.

---

## End-to-End: Sync Compatibility

1. Set up a two-node cluster (hub and spoke) per the sync documentation.
2. Activate a skill on the spoke.
3. Trigger a sync cycle. Verify the skill row and associated files appear on the hub.
4. Retire the skill on the hub via operator CLI.
5. Trigger another sync cycle. Verify the spoke picks up `status = 'retired'` via LWW reducer.
6. Verify the `change_log` entries propagated correctly.

---

## Traceability

| Criterion | Automated Test | Manual Step |
|-----------|----------------|-------------|
| AC1.1 | `schema.test.ts` — "verifies skills table has all required columns" | Phase 1, Step 1.1 |
| AC1.2 | `tsc -p packages/shared --noEmit` (compile-time) | N/A |
| AC1.3 | `schema.test.ts` — "insertRow and updateRow write change-log entries for skills table" | N/A |
| AC1.4 | `schema.test.ts` — "enforces unique index on active skill name" | Phase 1, Step 1.2 |
| AC1.5 | `schema.test.ts` — "allows idempotent schema application" | N/A |
| AC2.1 | `skill-commands.test.ts` — AC2.1 | Phase 3, Step 3.4 |
| AC2.2 | `skill-commands.test.ts` — AC2.2 | N/A |
| AC2.3 | `skill-commands.test.ts` — AC2.3 | N/A |
| AC2.4 | `skill-commands.test.ts` — AC2.4 | N/A |
| AC2.5 | `skill-commands.test.ts` — AC2.5 | N/A |
| AC2.6 | `skill-commands.test.ts` — AC2.6 | N/A |
| AC2.7 | `skill-commands.test.ts` — AC2.7 | Phase 3, Step 3.4 |
| AC2.8 | `skill-commands.test.ts` — AC2.8 | N/A |
| AC2.9 | `skill-commands.test.ts` — AC2.9 | Phase 3, Step 3.1 / Phase 5, Step 5.1 |
| AC2.10 | `skill-commands.test.ts` — AC2.10 | N/A |
| AC2.11 | `skill-commands.test.ts` — AC2.11 | N/A |
| AC2.12 | `skill-commands.test.ts` — AC2.12 | Phase 3, Step 3.2 / Phase 5, Step 5.2 |
| AC2.13 | `skill-commands.test.ts` — AC2.13 | N/A |
| AC2.14 | `skill-commands.test.ts` — AC2.14 | Phase 3, Step 3.3 |
| AC2.15 | `skill-commands.test.ts` — AC2.15 | Phase 3, Step 3.3 |
| AC2.16 | `skill-commands.test.ts` — AC2.16 | End-to-End Lifecycle Step 5 |
| AC3.1 | `context-assembly.test.ts` — AC3.1 | Phase 4, Step 4.1 |
| AC3.2 | `context-assembly.test.ts` — AC3.2 | End-to-End Lifecycle Step 6 |
| AC3.3 | `context-assembly.test.ts` — AC3.3 | End-to-End Lifecycle Step 4 |
| AC3.4 | `context-assembly.test.ts` — AC3.4 | N/A |
| AC3.5 | `context-assembly.test.ts` — AC3.5 | N/A |
| AC3.6 | `context-assembly.test.ts` — AC3.6 | Phase 4, Step 4.2 |
| AC3.7 | `context-assembly.test.ts` — AC3.7 | Phase 4, Step 4.3 |
| AC4.1 | `skill-cli.test.ts` — AC4.1 | Phase 5, Step 5.1 |
| AC4.2 | `skill-cli.test.ts` — AC4.2 | Phase 5, Step 5.2 |
| AC4.3 | `skill-cli.test.ts` — AC4.3 | Phase 5, Step 5.3 |
| AC4.4 | `skill-cli.test.ts` — AC4.4 | Phase 5, Step 5.3 |
| AC4.5 | `skill-cli.test.ts` — AC4.5 | Phase 5, Step 5.4 |
| AC4.6 | `skill-cli.test.ts` — AC4.6 | Phase 5, Step 5.5 |
| AC5.1 | `seed-skills.test.ts` — AC5.1 | Phase 2, Step 2.1 |
| AC5.2 | `seed-skills.test.ts` — AC5.2 | Phase 1, Step 1.3 |
| AC5.3 | `seed-skills.test.ts` — AC5.3 | Phase 2, Step 2.3 |
| AC5.4 | `seed-skills.test.ts` — AC5.4 | Phase 2, Step 2.2 |
| AC5.5 | `seed-skills.test.ts` — AC5.5 | N/A |
