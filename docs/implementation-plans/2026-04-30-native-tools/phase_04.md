# Native Agent Tools Implementation Plan — Phase 4

**Goal:** Remove the bash-dispatched command infrastructure now that all 20 commands are native tools. MCP bridge commands remain as bash-dispatched.

**Architecture:** Delete the 20 command handler files (advisory, archive, await-cmd, cache-*, cancel, emit, hostinfo, memory, model-hint, notify, purge, query, schedule, skill-*). Remove `getAllCommands()` and `addMCPCommands()` from the commands index. Trim `createDefineCommands()` callers so it only processes MCP commands (not built-in commands). Update `sandboxTool` description to remove the built-in command listing. Retain `loopContextStorage` for MCP bridge relay side-channel and `createDefineCommands()` for MCP command dispatch. Delete old command test files.

**Tech Stack:** TypeScript, bun:test

**Scope:** 6 phases from original design (phase 4 of 6)

**Codebase verified:** 2026-04-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### native-tools.AC4: Old command dispatch path is fully removed
- **native-tools.AC4.1 Success:** No `CommandDefinition` handler files exist in `packages/agent/src/commands/` (except MCP bridge, registry, index)
- **native-tools.AC4.2 Success:** `createDefineCommands()` is only called with MCP bridge commands (built-in command definitions no longer pass through it)
- **native-tools.AC4.3 Success:** `sandboxTool` description no longer lists built-in commands
- **native-tools.AC4.4 Success:** MCP bridge commands still dispatch correctly through bash

---

<!-- START_TASK_1 -->
### Task 1: Delete the 20 command handler files

**Files:**
- Delete: `packages/agent/src/commands/advisory.ts`
- Delete: `packages/agent/src/commands/archive.ts`
- Delete: `packages/agent/src/commands/await-cmd.ts`
- Delete: `packages/agent/src/commands/cache-evict.ts`
- Delete: `packages/agent/src/commands/cache-pin.ts`
- Delete: `packages/agent/src/commands/cache-unpin.ts`
- Delete: `packages/agent/src/commands/cache-warm.ts`
- Delete: `packages/agent/src/commands/cancel.ts`
- Delete: `packages/agent/src/commands/emit.ts`
- Delete: `packages/agent/src/commands/hostinfo.ts`
- Delete: `packages/agent/src/commands/memory.ts`
- Delete: `packages/agent/src/commands/model-hint.ts`
- Delete: `packages/agent/src/commands/notify.ts`
- Delete: `packages/agent/src/commands/purge.ts`
- Delete: `packages/agent/src/commands/query.ts`
- Delete: `packages/agent/src/commands/schedule.ts`
- Delete: `packages/agent/src/commands/skill-activate.ts`
- Delete: `packages/agent/src/commands/skill-list.ts`
- Delete: `packages/agent/src/commands/skill-read.ts`
- Delete: `packages/agent/src/commands/skill-retire.ts`

**Implementation:**

Delete all 20 command handler files. These are fully replaced by the native tool factories in `packages/agent/src/tools/`.

**Keep** the following files in `packages/agent/src/commands/`:
- `helpers.ts` — `commandError()`, `commandSuccess()`, `handleCommandError()` may still be used by MCP bridge or other code. Check imports after deletion; if only used by deleted files, delete it too.
- `index.ts` — will be trimmed in Task 2
- `registry.ts` — will be trimmed in Task 2

Also check if `parseFrontmatter()` from `skill-activate.ts` is imported by the new `skill.ts` tool. If so, extract it to a shared location (e.g., `packages/agent/src/tools/skill.ts` or a utils file) BEFORE deleting `skill-activate.ts`. The Phase 3 implementation should have already handled this by either inlining the function or importing from a different location.

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Will likely fail with import errors — that's expected, fixed in Task 2

**Commit:** `refactor(agent): delete 20 bash-dispatched command handler files`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Trim commands/index.ts and registry.ts

**Verifies:** native-tools.AC4.1

**Files:**
- Modify: `packages/agent/src/commands/index.ts`
- Modify: `packages/agent/src/commands/registry.ts`

**Implementation:**

**index.ts** currently exports `getAllCommands()` (returns 18 CommandDefinitions), `addMCPCommands()`, individual command exports, and re-exports from registry. After removal:

- Remove `getAllCommands()` function entirely
- Remove `addMCPCommands()` function entirely
- Remove all individual command imports and exports (advisory, query, memory, schedule, etc.)
- Keep re-exports of `setCommandRegistry` and `getCommandRegistry` from `./registry.js`

The trimmed `index.ts` should look approximately like:

```typescript
export { setCommandRegistry, getCommandRegistry } from "./registry.js";
```

**registry.ts** stays the same — it's a simple singleton that now only stores MCP bridge commands. No changes needed to its API.

Update `packages/agent/src/index.ts` (the package-level index) to remove any exports that referenced the deleted commands. Keep exports of:
- `setCommandRegistry`, `getCommandRegistry` (from commands)
- `generateMCPCommands`, `MCPCommandsResult`, `generateRemoteMCPProxyCommands`, `RemoteMCPCommandsResult` (from mcp-bridge)
- All new tool-related exports (from tools/)

**Verification:**
Run: `tsc -p packages/agent --noEmit`
Expected: Clean typecheck (import errors from Task 1 resolved)

**Commit:** `refactor(agent): trim commands index to MCP bridge registry only`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Remove built-in commands from CLI sandbox.ts command assembly

**Verifies:** native-tools.AC4.2, native-tools.AC4.4

**Files:**
- Modify: `packages/cli/src/commands/start/sandbox.ts` (this is the CLI startup file, NOT `packages/sandbox/src/commands.ts` which defines `createDefineCommands` and is retained for MCP bridge dispatch)

**Implementation:**

Currently `sandbox.ts` at line ~69-82:
1. Gets built-in commands from `getAllCommands()` 
2. Gets remote MCP proxy commands from `generateRemoteMCPProxyCommands()`
3. Merges them: `const allDefinitions = [...builtInCommands, ...remoteMcpCommands]`
4. Calls `setCommandRegistry(allDefinitions)` 
5. Calls `createDefineCommands(allDefinitions, commandContext)` to create just-bash CustomCommands

After removal:
1. Remove the `getAllCommands()` import and call
2. Remote MCP proxy commands (if any) are the only CommandDefinitions going through the bash path
3. `setCommandRegistry()` receives only MCP commands (remote + local)
4. `createDefineCommands()` receives only MCP commands

Update to:

```typescript
// Remote MCP proxy commands (if multi-host with remote MCP servers)
const remoteMcpResult = generateRemoteMCPProxyCommands(...);
const remoteMcpCommands = remoteMcpResult?.commands ?? [];

// Only MCP commands go through the bash dispatch path now
const allDefinitions = [...remoteMcpCommands];
setCommandRegistry(allDefinitions);
const customCommands = createDefineCommands(allDefinitions, commandContext);
```

The `mcp.ts` file also calls `setCommandRegistry()` and `createDefineCommands()` during MCP init/reload — these already only pass MCP commands (local MCP bridge commands), so no changes needed there.

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: Clean typecheck

Verify MCP bridge commands still work by checking that `createDefineCommands` still processes MCP CommandDefinitions correctly.

**Commit:** `refactor(cli): remove built-in commands from sandbox bash dispatch`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update sandboxTool description

**Verifies:** native-tools.AC4.3

**Files:**
- Modify: `packages/cli/src/commands/start/agent-factory.ts`

**Implementation:**

Update the `sandboxTool` constant (lines 20-37) to remove the built-in command listing from the description. The bash tool is now only for shell commands and MCP tool dispatch.

Change from:
```typescript
description:
	"Execute a command in the sandboxed shell. Built-in commands: query, memorize, forget, schedule, cancel, emit, purge, await, cache-warm, cache-pin, cache-unpin, cache-evict, model-hint, archive, hostinfo. MCP tools are also available as commands. Run standard shell commands too.",
```

To:
```typescript
description:
	"Execute a command in the sandboxed shell. MCP tools are available as commands. Run standard shell commands too.",
```

**Verification:**
Run: `tsc -p packages/cli --noEmit`
Expected: Clean typecheck

**Commit:** `refactor(cli): remove built-in command listing from bash tool description`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Delete old command test files

**Files:**
- Delete: `packages/agent/src/__tests__/commands.test.ts` (covers advisory, await-cmd, cancel, emit, memory, purge, query, schedule)
- Delete: `packages/agent/src/__tests__/cache-commands.test.ts`
- Delete: `packages/agent/src/__tests__/skill-commands.test.ts`
- Keep: `packages/agent/src/__tests__/mcp-bridge.test.ts` (MCP bridge is preserved)

**Implementation:**

Delete the 3 test files that tested the old command handlers. The native tools in `packages/agent/src/tools/__tests__/` replace these tests.

Check that `mcp-bridge.test.ts` doesn't import anything from the deleted command files. If it does, update imports.

Also check if `helpers.ts` is still imported by any remaining code. If not, delete it too.

**Verification:**
Run: `bun test --recursive`
Expected: Exit code 0 — all remaining tests pass, no broken imports

**Commit:** `test(agent): remove old command handler test files`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Clean up loopContextStorage usage

**Files:**
- Possibly modify: `packages/sandbox/src/commands.ts`

**Implementation:**

`loopContextStorage` (AsyncLocalStorage) is used in 3 places:
1. `packages/sandbox/src/commands.ts:180` — in `createDefineCommands()` to merge threadId/taskId into command context
2. `packages/cli/src/commands/start/agent-factory.ts:74` — wraps `sandbox.bash.exec()` with per-loop context (threadId, taskId, relayRequest side-channel)
3. `packages/agent/src/mcp-bridge.ts:685` — remote MCP proxy sets `store.relayRequest`

Usage #1 is still needed because MCP bridge commands still go through `createDefineCommands()`. Usage #2 and #3 are the relay side-channel — still needed for remote MCP proxy.

**No changes needed** — `loopContextStorage` and `createDefineCommands()` both remain for MCP bridge support. Verify this by confirming MCP bridge commands still dispatch correctly.

**Verification:**
Run: `bun test packages/agent/src/__tests__/mcp-bridge.test.ts`
Expected: All MCP bridge tests pass

**Commit:** No commit — verification only.
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Verify full test suite and typecheck

**Files:** None (verification only)

**Verification:**
Run: `bun test --recursive`
Expected: Exit code 0, no new failures

Run: `bun run typecheck`
Expected: Clean typecheck across all packages

Verify that the only files remaining in `packages/agent/src/commands/` are:
- `index.ts` (re-exports registry)
- `registry.ts` (singleton for MCP commands)
- `helpers.ts` (only if still used by other code)

**Commit:** No commit — verification only. Fix any regressions before proceeding.
<!-- END_TASK_7 -->
