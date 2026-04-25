# Command Discovery Redesign Implementation Plan

**Goal:** Hard removal of the `commands` command. Discovery flows through orientation block + `<cmd> --help` only. The file `help.ts` is renamed to `registry.ts` to match its remaining contents (registry accessors).

**Architecture:** Delete the `help` `CommandDefinition` export from `help.ts`, rename the file to `registry.ts`, update all importers, remove `help` from `getAllCommands()`, delete the `commands command` test suite, and grep docs for stale references. Per hard-rename convention: no deprecation shim, cron prompts fail on next run and self-correct.

**Tech Stack:** TypeScript 6.x, Bun monorepo

**Scope:** 6 phases from original design (phases 1-6). This is phase 6 of 6.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### command-discovery-redesign.AC4: The `commands` command is removed
- **command-discovery-redesign.AC4.1 Failure:** Invoking `commands` returns `command not found` (or equivalent dispatcher not-found error).
- **command-discovery-redesign.AC4.2 Success:** `packages/agent/src/commands/registry.ts` (renamed from `help.ts` in Phase 6) no longer exports a `CommandDefinition` named `commands`; `setCommandRegistry` and `getCommandRegistry` remain exported for other callers.

---

<!-- START_TASK_1 -->
### Task 1: Delete the commands CommandDefinition and rename help.ts to registry.ts

**Verifies:** command-discovery-redesign.AC4.2

**Files:**
- Rename: `packages/agent/src/commands/help.ts` → `packages/agent/src/commands/registry.ts`
- Modify: the renamed `registry.ts` (delete the `help` export and its handler)

**Implementation:**

**Step 1: Rename the file.**

```bash
git mv packages/agent/src/commands/help.ts packages/agent/src/commands/registry.ts
```

**Step 2: Delete the `help` CommandDefinition from `registry.ts`.**

In the renamed `registry.ts`, delete:
- The `export const help: CommandDefinition = { ... }` block (lines 25-140 in the original help.ts). This is the entire `CommandDefinition` with `name: "commands"` and its handler.
- The `import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";` line can be simplified — remove `CommandContext` and `CommandResult` since they're only used by the deleted handler. Keep `CommandDefinition` (used by the registry type).

After deletion, `registry.ts` should contain only:
- `import type { CommandDefinition } from "@bound/sandbox";`
- Module-level state: `commandRegistry`, `serverNamesRegistry`, `remoteServerNamesRegistry`
- `setCommandRegistry()` function
- `getCommandRegistry()` function (added in Phase 5)

**Verification:**

The file compiles but imports will be broken until Task 2.

**Commit:** Do not commit yet — Task 2 fixes imports.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update all importers from help to registry

**Verifies:** command-discovery-redesign.AC4.2

**Files:**
- Modify: `packages/agent/src/commands/index.ts` (lines 11, 29-30, 54)
- Modify: `packages/agent/src/context-assembly.ts` (the import added in Phase 5)

**Implementation:**

**`packages/agent/src/commands/index.ts`:**

Line 11 — change import path and remove `help` symbol:
```typescript
// Before:
import { help, setCommandRegistry } from "./help";

// After:
import { setCommandRegistry, getCommandRegistry } from "./registry";
```

Lines 29-30 — remove `help` from the `getAllCommands()` return array:
```typescript
// Remove "help," from the array (line 30)
export function getAllCommands(): CommandDefinition[] {
	return [
		// help,  ← DELETE THIS LINE
		query,
		advisory,
		// ... rest unchanged
	];
}
```

Line 54 — update the re-export to include `getCommandRegistry` and point to new file:
```typescript
// Before:
export { setCommandRegistry };

// After:
export { setCommandRegistry, getCommandRegistry } from "./registry";
```

Note: If Phase 5 already added a re-export line for `getCommandRegistry`, consolidate into one line.

**`packages/agent/src/context-assembly.ts`:**

Update the import added in Phase 5:
```typescript
// Before:
import { getCommandRegistry } from "./commands/help";

// After:
import { getCommandRegistry } from "./commands/registry";
```

**CLI files (`sandbox.ts`, `mcp.ts`):** These import `setCommandRegistry` from `@bound/agent` via the barrel export. Since `index.ts` re-exports are updated above, no path changes needed in CLI files.

**Verification:**

Run: `bun run typecheck`
Expected: Passes. `grep -rn "commands/help" packages/` returns empty.

**Commit:** Do not commit yet — Task 3 updates tests.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update tests and remove commands command test suite

**Verifies:** command-discovery-redesign.AC4.1, command-discovery-redesign.AC4.2

**Files:**
- Modify: `packages/agent/src/__tests__/commands.test.ts` (line 18 import, lines 968-1145 test suite)

**Implementation:**

**Step 1: Update import path.**

Line 18:
```typescript
// Before:
import { help, setCommandRegistry } from "../commands/help";

// After:
import { setCommandRegistry } from "../commands/registry";
```

Remove `help` from the import since the `commands` CommandDefinition no longer exists.

**Step 2: Delete the `commands command` describe block.**

Delete the entire `describe("commands command", () => { ... })` block at lines 968-1145. This includes 5 tests that all called `help.handler()` directly — they test a command that no longer exists.

**Step 3: Verify remaining tests still reference `setCommandRegistry` correctly.**

Any remaining tests that call `setCommandRegistry` should work fine since the function moved but keeps the same signature.

**Testing:**

Tests must verify AC4.1 and AC4.2. Add to the existing test file (or the `--help and missing-arg hint` describe block):

- **command-discovery-redesign.AC4.1:** Test at the `getAllCommands()` level: import `getAllCommands` from `../commands/index`, assert no entry has `name === "commands"`. This is a sufficient proxy for the AC's "invoking `commands` returns `command not found`" requirement — if `commands` is not in `getAllCommands()`, the dispatcher will not register it, and the not-found behavior is already tested by the dispatcher's existing coverage.

- **command-discovery-redesign.AC4.2:** Import from `../commands/registry` — assert `setCommandRegistry` and `getCommandRegistry` are exported (they resolve without throwing). Assert there is no `help` export: `import * as registry from "../commands/registry"` and check that `registry` does NOT have a `help` property.

**Verification:**

Run: `bun test packages/agent/src/__tests__/commands.test.ts`
Expected: All remaining tests pass. Deleted tests no longer run.

Run: `bun test --recursive`
Expected: Full test suite passes.

**Commit:** `feat(agent): remove commands command, rename help.ts to registry.ts`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Grep docs for stale references to the commands command

**Files:**
- Potentially modify: files in `docs/` and `packages/` containing user-facing references to `commands` as a runtime command

**Implementation:**

Run the grep pass specified in the design:

```bash
grep -rn "'commands'\|\"commands\"\|run \`commands\`\|commands [a-z]" docs/ packages/ 2>/dev/null
```

**Known results from investigation:**

- `docs/design-plans/2026-03-25-mcp-relay.md` — lines 80, 434, 438: references `commands` command in design context. These are historical design documents describing prior state — update to note the command was removed, or leave as historical record. Use judgment: if the reference is in a "Done when" criterion that describes expected behavior, add a note that this was superseded by the command-discovery-redesign.

- `docs/design-plans/2026-03-28-mcp-subcommand-dispatch.md` — lines 46, 47, 91, 142, 166, 172: same treatment as above.

- `docs/design-plans/2026-04-21-command-discovery-redesign.md` — this IS the current design, references are intentional (describing what's being removed).

**Decision framework:** Design documents are historical records. Do NOT rewrite them. Only update if a reference could mislead a reader into thinking `commands` still exists as a runtime command. The design docs above describe the pre-change state, which is correct for their context. Leave them as-is.

Check for references in non-design files (e.g., README, operator guides, config templates). Update any that tell users to run `commands` — replace with `<cmd> --help` guidance.

**Verification:**

Run: `grep -rn "name: \"commands\"" packages/`
Expected: Empty (no CommandDefinition with name "commands" exists).

Run: `grep -rn "commands/help" packages/`
Expected: Empty (all importers migrated to `commands/registry`).

**Commit:** `docs: update stale references to removed commands command` (only if changes were made)
<!-- END_TASK_4 -->
