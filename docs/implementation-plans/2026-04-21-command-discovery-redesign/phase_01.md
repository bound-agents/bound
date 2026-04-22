# Command Discovery Redesign Implementation Plan

**Goal:** Extend the `CommandDefinition` interface with `description`, `helpText`, and `customHelp` fields, and populate descriptions on every built-in command so the tree typechecks cleanly.

**Architecture:** The `CommandDefinition` interface in `@bound/sandbox` gains three new fields. Every command export across `packages/agent/src/commands/*.ts` (21 files) adds the required `description` string. Descriptions are sourced from the existing `AVAILABLE_COMMANDS` constant in `context-assembly.ts` where available; two commands (`notify`, `commands`) need new descriptions written.

**Tech Stack:** TypeScript 6.x, Bun monorepo with `@bound/sandbox` and `@bound/agent` packages

**Scope:** 6 phases from original design (phases 1-6). This is phase 1 of 6.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### command-discovery-redesign.AC3: Orientation block reflects the command registry
- **command-discovery-redesign.AC3.4 Failure:** Registering a `CommandDefinition` without a `description` field is a TypeScript compile error.

**Verifies: None** (infrastructure phase — verified operationally via typecheck, not tests)

---

<!-- START_TASK_1 -->
### Task 1: Extend CommandDefinition interface

**Files:**
- Modify: `packages/sandbox/src/commands.ts:49-53`

**Implementation:**

Add three new fields to the `CommandDefinition` interface. The interface currently reads:

```typescript
export interface CommandDefinition {
	name: string;
	args: Array<{ name: string; required: boolean; description?: string }>;
	handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}
```

Change it to:

```typescript
export interface CommandDefinition {
	name: string;
	description: string;
	helpText?: string;
	customHelp?: boolean;
	args: Array<{ name: string; required: boolean; description?: string }>;
	handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}
```

- `description` is **required** — this is the mechanism behind AC3.4 (missing description = compile error).
- `helpText` is optional — Phase 4 uses it for subcommand-dispatched commands.
- `customHelp` is optional — Phase 2 uses it for MCP commands.

**Verification:**

At this point `bun run typecheck` will **fail** because all 21 command exports are missing the required `description` field. That is expected and fixed in Task 2.

**Commit:** Do not commit yet — Task 2 fixes the type errors.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Add descriptions to all 21 built-in command exports

**Files:**
- Modify: `packages/agent/src/commands/query.ts` (line 8, the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/memory.ts` (line 415, the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/advisory.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/schedule.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/cancel.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/emit.ts` (line 8, the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/purge.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/await-cmd.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/cache-warm.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/cache-pin.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/cache-unpin.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/cache-evict.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/model-hint.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/archive.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/hostinfo.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/notify.ts` (line 68, the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/skill-activate.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/skill-list.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/skill-read.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/skill-retire.ts` (the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/help.ts` (line 25, the `CommandDefinition` export)

**Implementation:**

Add a `description` field immediately after `name` in each command's `CommandDefinition` export. Use the exact strings from the `AVAILABLE_COMMANDS` constant in `packages/agent/src/context-assembly.ts:276-302`, which maps command names to descriptions.

The description strings to use, by command name:

| Command | Export variable | Description string |
|---------|----------------|-------------------|
| `query` | `query` | `"Execute a SELECT query against the database"` |
| `memory` | `memory` | `"Memory operations: store, forget, search, connect, disconnect (use subcommands)"` |
| `advisory` | `advisory` | `"Post a proactive advisory for operator review"` |
| `schedule` | `schedule` | `"Schedule a deferred, cron, or event-driven task"` |
| `cancel` | `cancel` | `"Cancel a scheduled task (supports --payload-match)"` |
| `emit` | `emit` | `"Emit a custom event on the event bus"` |
| `purge` | `purge` | `"Create a purge record targeting message IDs"` |
| `await` | `awaitCmd` | `"Poll until tasks reach a terminal state"` |
| `cache-warm` | `cacheWarm` | `"Pre-warm the prompt cache for a thread"` |
| `cache-pin` | `cachePin` | `"Pin a cache entry to prevent eviction"` |
| `cache-unpin` | `cacheUnpin` | `"Unpin a previously pinned cache entry"` |
| `cache-evict` | `cacheEvict` | `"Evict a specific cache entry"` |
| `model-hint` | `modelHint` | `"Set or clear the model hint for the current task"` |
| `archive` | `archive` | `"Archive a thread to long-term storage"` |
| `hostinfo` | `hostinfo` | `"Display registered host information"` |
| `skill-activate` | `skillActivate` | `"Activate a skill from /home/user/skills/{name}/SKILL.md"` |
| `skill-list` | `skillList` | `"List skills with status, activations, and description"` |
| `skill-read` | `skillRead` | `"Read a skill's SKILL.md content with status header"` |
| `skill-retire` | `skillRetire` | `"Retire a skill; scans tasks and creates advisories"` |

Two commands are **not** in `AVAILABLE_COMMANDS` and need new descriptions:

| Command | Export variable | Description string |
|---------|----------------|-------------------|
| `notify` | `notify` | `"Send a notification to users on configured platforms"` |
| `commands` | `help` | `"List available commands and show per-command usage"` |

For each file, add `description: "<string>",` as the second field after `name`. Example for `query.ts`:

```typescript
export const query: CommandDefinition = {
	name: "query",
	description: "Execute a SELECT query against the database",
	args: [{ name: "query", required: true, description: "SQL SELECT query to execute" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
```

And for `help.ts`:

```typescript
export const help: CommandDefinition = {
	name: "commands",
	description: "List available commands and show per-command usage",
	args: [
		{ name: "command", required: false, description: "Command name to get detailed help for" },
	],
	handler: async (args, ctx: CommandContext): Promise<CommandResult> => {
```

**Verification:**

Run: `bun run typecheck`
Expected: All packages pass with no errors. Any `CommandDefinition` missing `description` would be a compile error, proving AC3.4.

**Commit:** `feat(sandbox): extend CommandDefinition with description, helpText, customHelp fields`
<!-- END_TASK_2 -->
