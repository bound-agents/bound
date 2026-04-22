# Command Discovery Redesign Implementation Plan

**Goal:** `memory --help` and `advisory --help` return rich subcommand listings instead of the generic auto-generated stub, so the agent sees per-subcommand usage when it asks for help.

**Architecture:** Add `helpText` overrides to the `memory` and `advisory` `CommandDefinition` exports. The `formatHelp` utility (from Phase 3) renders `helpText` verbatim when present, bypassing auto-generation. Only two commands need this treatment — `memory` (7 subcommands) and `advisory` (6 subcommands). Skill-* commands do NOT dispatch on a `subcommand` arg and do not need helpText overrides.

**Tech Stack:** TypeScript 6.x, Bun monorepo

**Scope:** 6 phases from original design (phases 1-6). This is phase 4 of 6.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### command-discovery-redesign.AC1: `--help` works on every command
- **command-discovery-redesign.AC1.2 Success:** `memory --help` returns a subcommand listing (store / forget / search / connect / disconnect) with argument signatures, sourced from the command's `helpText` override.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Add helpText to memory and advisory CommandDefinitions

**Verifies:** command-discovery-redesign.AC1.2

**Files:**
- Modify: `packages/agent/src/commands/memory.ts` (line 415, the `CommandDefinition` export)
- Modify: `packages/agent/src/commands/advisory.ts` (line 160, the `CommandDefinition` export)

**Implementation:**

Add a `helpText` field to each command's `CommandDefinition` export. The helpText should enumerate all subcommands with their argument signatures, sourced from the handler implementations.

**memory.ts** — add `helpText` after `description` in the export (around line 416):

```typescript
export const memory: CommandDefinition = {
	name: "memory",
	description: "Memory operations: store, forget, search, connect, disconnect (use subcommands)",
	helpText: [
		"Subcommands:",
		"",
		"  store <key> <value> [--source_tag S] [--tier TIER]",
		"    Store a memory. Tier: pinned, summary, default, detail.",
		"",
		"  forget <key> [--prefix P]",
		"    Forget a memory by exact key, or by prefix with --prefix.",
		"",
		"  search <query>",
		"    Search memories by keyword.",
		"",
		"  connect <source> <target> <relation> [--weight N] [--context \"phrase\"]",
		"    Create an edge between two memory keys.",
		"",
		"  disconnect <source> <target> [relation]",
		"    Remove an edge. If relation is omitted, removes all edges between source and target.",
		"",
		"  traverse <key> [--depth N] [--relation R]",
		"    Walk the memory graph from a key. Depth 1-3 (default 2).",
		"",
		"  neighbors <key> [--dir out|in|both]",
		"    List direct neighbors of a key.",
	].join("\n"),
	args: [
		// ... existing args unchanged ...
```

**advisory.ts** — add `helpText` after `description` in the export (around line 161):

```typescript
export const advisory: CommandDefinition = {
	name: "advisory",
	description: "Post a proactive advisory for operator review",
	helpText: [
		"Subcommands:",
		"",
		"  create --title T --detail D [--action A] [--impact I]",
		"    Post a new advisory for operator review.",
		"",
		"  list [--status S]",
		"    List advisories. Filter by status: proposed, approved, applied, dismissed, deferred.",
		"",
		"  approve <id>",
		"    Approve a proposed advisory.",
		"",
		"  apply <id>",
		"    Mark an approved advisory as applied.",
		"",
		"  dismiss <id>",
		"    Dismiss a proposed advisory.",
		"",
		"  defer <id> [--until ISO]",
		"    Defer an advisory until a given date.",
	].join("\n"),
	args: [
		// ... existing args unchanged ...
```

**Verification:**

Run: `bun run typecheck`
Expected: Passes. helpText is an optional string field on CommandDefinition (added in Phase 1).

**Commit:** Do not commit yet — Task 2 adds tests.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Test helpText rendering for memory and advisory

**Verifies:** command-discovery-redesign.AC1.2

**Files:**
- Modify: `packages/sandbox/src/__tests__/commands.test.ts` (add tests to the `--help and missing-arg hint` describe block from Phase 3)

**Testing:**

Tests must verify AC1.2:

- **command-discovery-redesign.AC1.2:** Import the `memory` and `advisory` `CommandDefinition` exports from `@bound/agent/src/commands/memory` and `@bound/agent/src/commands/advisory` respectively (or construct equivalent test fixtures with the same `helpText`). Create commands via `createDefineCommands`, invoke with `["--help"]`. Assert:
  - `exitCode === 0`
  - `stdout` contains `"Subcommands:"`
  - For memory: `stdout` contains `"store"`, `"forget"`, `"search"`, `"connect"`, `"disconnect"`, `"traverse"`, `"neighbors"` (all 7 subcommand names)
  - For advisory: `stdout` contains `"create"`, `"list"`, `"approve"`, `"apply"`, `"dismiss"`, `"defer"` (all 6 subcommand names)
  - `stdout` contains the command description line (e.g., `"memory — Memory operations:"`)

Note: To avoid a cross-package import dependency from sandbox tests to agent commands, construct test `CommandDefinition` fixtures with representative `helpText` strings instead of importing the real commands. The test validates that `formatHelp` renders `helpText` verbatim when present — it does not need the real command handlers.

**Verification:**

Run: `bun test packages/sandbox/src/__tests__/commands.test.ts`
Expected: All tests pass.

**Commit:** `feat(agent): add helpText overrides for memory and advisory subcommand help`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->
