# Command Discovery Redesign Implementation Plan

**Goal:** The orientation block's command list is auto-generated from the live command registry instead of a hand-maintained constant. New commands (including MCP) appear without editing `context-assembly.ts`.

**Architecture:** Add a `getCommandRegistry()` export to `help.ts` that exposes the module-level `commandRegistry` populated by `setCommandRegistry` at boot. In `context-assembly.ts`, delete the `AVAILABLE_COMMANDS` constant (lines 276-302) and replace the rendering site (line 1000) with a call to `getCommandRegistry()`, sorted alphabetically by name. Update the footer text from `commands` references to `<cmd> --help`.

**Tech Stack:** TypeScript 6.x, Bun monorepo

**Scope:** 6 phases from original design (phases 1-6). This is phase 5 of 6.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### command-discovery-redesign.AC3: Orientation block reflects the command registry
- **command-discovery-redesign.AC3.1 Success:** A command registered via `setCommandRegistry` appears in the orientation block's command list without any change to `context-assembly.ts`.
- **command-discovery-redesign.AC3.2 Success:** MCP server-level commands appear in the orientation block's command list, sorted alphabetically alongside built-ins. (Test fixtures supply a representative MCP `CommandDefinition`; test asserts its name appears in the rendered list.)
- **command-discovery-redesign.AC3.3 Success:** The orientation block's footer includes (literal backticks around `<cmd> --help`):
  ```
  Run `<cmd> --help` for details on any command.
  ```
  replacing the current reference to the `commands` command / `commands <name>`.

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Add getCommandRegistry export to help.ts

**Files:**
- Modify: `packages/agent/src/commands/help.ts` (after `setCommandRegistry`, around line 23)

**Implementation:**

Add a new exported function after `setCommandRegistry` that returns the module-level `commandRegistry`:

```typescript
/**
 * Return the command registry populated at boot by setCommandRegistry.
 * Used by context-assembly to render the orientation block's command list.
 * Returns [] before boot; context-assembly must run after setCommandRegistry.
 */
export function getCommandRegistry(): readonly CommandDefinition[] {
	return commandRegistry;
}
```

The `readonly` return type prevents callers from mutating the shared array.

Also add the re-export in `packages/agent/src/commands/index.ts`. After the existing `export { setCommandRegistry };` line (line 54), add:

```typescript
export { setCommandRegistry, getCommandRegistry } from "./help";
```

(Replace the existing single `export { setCommandRegistry };` line.)

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: Passes.

**Commit:** Do not commit yet — Task 2 wires it up.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Replace AVAILABLE_COMMANDS with registry-driven rendering

**Verifies:** command-discovery-redesign.AC3.1, command-discovery-redesign.AC3.2, command-discovery-redesign.AC3.3

**Files:**
- Modify: `packages/agent/src/context-assembly.ts` (lines 276-302 for deletion, lines 1000-1014 for rendering replacement, imports section)

**Implementation:**

**Step 1: Add import.**

Add to the imports at the top of `context-assembly.ts`:

```typescript
import { getCommandRegistry } from "./commands/help";
```

**Step 2: Delete AVAILABLE_COMMANDS.**

Remove the entire `AVAILABLE_COMMANDS` constant at lines 276-302 (the `const AVAILABLE_COMMANDS = [...]  as const;` block).

**Step 3: Update the orientation rendering site.**

At lines 1000-1014, replace the current code:

```typescript
const commandList = AVAILABLE_COMMANDS.map((c) => `  ${c.name} — ${c.description}`).join("\n");
const orientationLines: string[] = [
	"## Orientation",
	"",
	"### Available Commands",
	commandList,
	"",
	"Run `commands` to list all commands (including MCP tools), or `commands <name>` for detailed syntax.",
	"",
	`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
];
```

With:

```typescript
const registry = getCommandRegistry();
const commandList = [...registry]
	.sort((a, b) => a.name.localeCompare(b.name))
	.map((c) => `  ${c.name} — ${c.description}`)
	.join("\n");
const orientationLines: string[] = [
	"## Orientation",
	"",
	"### Available Commands",
	commandList,
	"",
	"Run `<cmd> --help` for details on any command.",
	"",
	`### Host Identity\nHost: ${hostName || "unknown"}\nSite ID: ${siteId || "unknown"}`,
];
```

Key changes:
- Source: `getCommandRegistry()` instead of `AVAILABLE_COMMANDS`
- Sort: alphabetical by `name` (the old constant was manually ordered)
- Footer: `Run \`<cmd> --help\` for details on any command.` replaces the `commands` reference

**Verification:**

Run: `bun run typecheck`
Expected: Passes. No references to `AVAILABLE_COMMANDS` remain.

**Commit:** Do not commit yet — Task 3 adds tests.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for registry-driven orientation block

**Verifies:** command-discovery-redesign.AC3.1, command-discovery-redesign.AC3.2, command-discovery-redesign.AC3.3

**Files:**
- Modify: `packages/agent/src/__tests__/context-assembly.test.ts` (add new describe block)

**Testing:**

Add a new `describe("orientation block command registry")` block. The existing test file already creates databases with `createDatabase()` + `applySchema(db)` and calls `assembleContext()`.

Tests must verify each AC:

- **command-discovery-redesign.AC3.1:** Call `setCommandRegistry` with a list containing a custom test command (e.g., `{ name: "test-cmd", description: "A test command", args: [], handler: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }`). Then call `assembleContext()`. Find the orientation system message (contains `"## Orientation"`). Assert `stdout` contains `"test-cmd — A test command"`. This proves new commands appear without editing context-assembly.ts.

- **command-discovery-redesign.AC3.2:** Call `setCommandRegistry` with a mix of built-in and MCP-style commands (e.g., `{ name: "atproto", description: "MCP server exposing 5 tools", customHelp: true, args: [...], handler: ... }` alongside `{ name: "query", description: "Execute a SELECT query", args: [...], handler: ... }`). Assert the orientation block contains both `"atproto"` and `"query"`, and that `"atproto"` appears before `"query"` (alphabetical sort).

- **command-discovery-redesign.AC3.3:** Assert the orientation block contains the literal string `Run \`<cmd> --help\` for details on any command.` (with backticks). Assert it does NOT contain `"commands <name>"` or `"Run \`commands\`"`.

Important: `setCommandRegistry` is module-level state. Tests that call it should restore previous state in `afterEach`/`afterAll` to avoid polluting other test runs. Save the return of `getCommandRegistry()` before the test and restore via `setCommandRegistry([...saved])` after.

**Verification:**

Run: `bun test packages/agent/src/__tests__/context-assembly.test.ts`
Expected: All new and existing tests pass.

**Commit:** `feat(agent): auto-generate orientation block from command registry`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
