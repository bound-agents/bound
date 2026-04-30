# Native Agent Tools Implementation Plan — Phase 6

**Goal:** Update all documentation to reflect the native tool architecture. Remove references to the old `CommandDefinition` dispatch pattern (except in historical design docs and specs).

**Architecture:** Documentation updates span 5 active documentation files: CLAUDE.md, CONTRIBUTING.md, README.md, docs/design/agent-system.md, docs/design/architecture.md, and docs/design/sandbox-and-llm.md. Historical spec files (`docs/design/specs/`) and old implementation plans are left unchanged as historical records.

**Tech Stack:** Markdown documentation

**Scope:** 6 phases from original design (phase 6 of 6)

**Codebase verified:** 2026-04-30

---

## Acceptance Criteria Coverage

This phase implements and tests:

### native-tools.AC7: Documentation is accurate
- **native-tools.AC7.1 Success:** CLAUDE.md references native tools, not bash commands, for agent tool dispatch
- **native-tools.AC7.2 Success:** CONTRIBUTING.md "Adding an agent tool" checklist describes the `RegisteredTool` factory pattern
- **native-tools.AC7.3 Success:** No documentation references the old `CommandDefinition` dispatch pattern (except historical design docs)

Verifies: None (infrastructure/documentation phase)

---

<!-- START_TASK_1 -->
### Task 1: Update CLAUDE.md

**Verifies:** native-tools.AC7.1

**Files:**
- Modify: `CLAUDE.md`

**Implementation:**

Update the following sections in CLAUDE.md:

**1. "Tool dispatch priority" section in Operational mental model:**

Currently says:
```
### Tool dispatch priority

Platform tools → client tools → built-in tools → sandbox/MCP.
```

Update to:
```
### Tool dispatch priority

All tools dispatch through the unified tool registry (`Map<string, RegisteredTool>`). Each tool is tagged with a `kind` discriminant:
- `"platform"` — platform connector tools (e.g., discord_send_message)
- `"client"` — client-side tools (deferred to WS client)
- `"builtin"` — file tools (read/write/edit/retrieve_task) and 14 native agent tools
- `"sandbox"` — bash tool (shell commands + MCP bridge dispatch)

Priority is determined at registration time. Unknown tool names return an error.
```

**2. "MCP subcommand dispatch" section:**

Currently references `CommandDefinition` and `getCommandRegistry()`. Update to note that MCP bridge commands remain as the only bash-dispatched commands. The section should still describe how MCP commands work since they're unchanged, but remove any implication that built-in agent commands also go through this path:

Update the opening to:
```
### MCP subcommand dispatch

One `CommandDefinition` per MCP server with a `subcommand` parameter (the only commands still dispatched through the bash sandbox). `generateMCPCommands()` returns `{ commands, serverNames }`. ...
```

Update the last sentence about orientation:
```
The orientation system message shows "### Additional MCP Commands" listing only MCP bridge entries (native agent tools are self-describing through their ToolDefinition schemas).
```

**3. "Adding an agent command" checklist pointer:**

The CLAUDE.md itself doesn't have the checklist (it's in CONTRIBUTING.md), but if there's a reference to "### Adding an agent command" in the CONTRIBUTING.md pointer, update the reference to "### Adding an agent tool".

**Commit:** `docs: update CLAUDE.md for native tool dispatch architecture`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Update CONTRIBUTING.md

**Verifies:** native-tools.AC7.2

**Files:**
- Modify: `CONTRIBUTING.md`

**Implementation:**

**1. Replace "Adding an agent command" checklist (lines 202-209):**

Currently:
```markdown
### Adding an agent command

1. Create `packages/agent/src/commands/<name>.ts` implementing `CommandDefinition` with a required `description` (used for auto-generated orientation + `--help` text).
2. Register it in `packages/agent/src/commands/registry.ts` / the command registry wiring.
3. If it needs filesystem access, type-annotate `ctx.fs?: IFileSystem`.
4. If it's platform-scoped, gate it in the relevant `PlatformConnector`.
5. Add unit tests under `packages/agent/src/commands/__tests__/` — mock `CommandContext` minimally.
6. `--help` / `-h` is handled by `formatHelp()` automatically unless `customHelp: true`.
```

Replace with:
```markdown
### Adding an agent tool

1. Create `packages/agent/src/tools/<name>.ts` exporting a `create<Name>Tool(ctx: ToolContext): RegisteredTool` factory function.
2. Define a `ToolDefinition` with JSON schema parameters (flat params, proper types). The LLM receives structured JSON — no string parsing needed.
3. Implement the `execute` handler: `(input: Record<string, unknown>) => Promise<BuiltInToolResult>`. Access `ctx.db`, `ctx.siteId`, `ctx.eventBus`, etc. via the closure.
4. Register the factory in `packages/agent/src/tools/index.ts` by adding it to the `createAgentTools()` array.
5. Add unit tests under `packages/agent/src/tools/__tests__/` — use real temp SQLite DBs, minimal `ToolContext` stubs.
6. For grouped tools (multiple operations), use an `action` enum parameter to dispatch (see memory, cache, skill tools).
```

**2. Update the "Common Gotchas" section:**

The gotcha about "Mixed positional + flag arg parsing" (commands.ts hasFlags heuristic) is no longer relevant for native tools. Update it to note this only applies to MCP bridge commands now:

```markdown
- **Mixed positional + flag arg parsing** (in `commands.ts`): Only affects MCP bridge commands (the only commands still dispatched through bash). Native agent tools use structured JSON parameters, eliminating this class of bugs.
```

**Commit:** `docs: update CONTRIBUTING.md with RegisteredTool factory pattern checklist`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Update README.md

**Verifies:** native-tools.AC7.3

**Files:**
- Modify: `README.md`

**Implementation:**

**1. Project structure (line 85):**

Currently:
```
agent/        Agent loop state machine, 8-stage context pipeline, 20+ commands, scheduler, MCP bridge
```

Update to:
```
agent/        Agent loop state machine, 8-stage context pipeline, 14 native tools, scheduler, MCP bridge
```

**2. Architecture section (line 160):**

Currently:
```markdown
- **20+ built-in commands** available to the agent (`query`, `memorize`, `schedule`, `purge`, `skill-*`, `advisory`, cache controls, etc.). The full list is auto-generated into the agent's orientation message from the command registry.
```

Update to:
```markdown
- **14 native agent tools** with structured JSON schemas (`schedule`, `query`, `memory`, `cache`, `skill`, `advisory`, `emit`, `cancel`, `purge`, `notify`, `archive`, `model_hint`, `hostinfo`, `await_event`). Tools receive typed parameters directly from the LLM, eliminating argument-parsing bugs.
```

**Commit:** `docs: update README.md for native tool architecture`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Update docs/design/agent-system.md

**Verifies:** native-tools.AC7.3

**Files:**
- Modify: `docs/design/agent-system.md`

**Implementation:**

This file has the most extensive references. Update these sections:

**1. Built-in Commands section (around line 269):**

Replace the paragraph that lists all commands as `CommandDefinition` objects dispatched by the sandbox with a description of the native tool architecture:

```markdown
### Native Agent Tools

Agent tools are implemented as `RegisteredTool` factories in `packages/agent/src/tools/`. Each factory closes over a `ToolContext` (db, siteId, eventBus, logger, threadId, taskId, modelRouter, fs) and returns a `RegisteredTool` with a JSON schema `ToolDefinition` and an `execute` handler.

The 14 native tools replace the previous 20 bash-dispatched commands:

| Tool | Actions / Params | Kind |
|------|-----------------|------|
| `memory` | action: store, forget, search, connect, disconnect, traverse, neighbors | Grouped |
| `cache` | action: warm, pin, unpin, evict | Grouped |
| `skill` | action: activate, list, read, retire | Grouped |
| `schedule` | task_description, cron, delay, on_event, model_hint, ... | Standalone |
| `cancel` | task_id, payload_match | Standalone |
| `query` | sql | Standalone |
| `emit` | event, payload | Standalone |
| `await_event` | task_ids, timeout | Standalone |
| `purge` | message_ids, last_n, thread_id | Standalone |
| `advisory` | title, detail, action, impact, list, approve, apply, dismiss, defer | Standalone |
| `notify` | user, all, platform, message | Standalone |
| `archive` | thread_id, older_than | Standalone |
| `model_hint` | model, reset | Standalone |
| `hostinfo` | (no params) | Standalone |

Tools dispatch through the unified tool registry (`Map<string, RegisteredTool>`) in the agent loop's `executeToolCall()` method. The registry replaces the previous waterfall dispatch pattern.
```

**2. Memory command docs (around line 312):**

Update "Unified memory command dispatched by subcommand" to reference the native tool with `action` parameter instead.

**3. Auto-Generated Commands from MCP Tools section (around lines 814-832):**

This section describes MCP bridge commands. Keep it but update the framing to note that MCP bridge is the ONLY command path still using `CommandDefinition` dispatch:

Add a note at the start: "MCP bridge commands are the only commands still dispatched through the bash sandbox via `CommandDefinition` handlers. All other agent tools use the native `RegisteredTool` architecture described above."

**Commit:** `docs: update agent-system.md for native tool architecture`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Update docs/design/sandbox-and-llm.md

**Verifies:** native-tools.AC7.3

**Files:**
- Modify: `docs/design/sandbox-and-llm.md`

**Implementation:**

**1. Command Framework section (lines ~142-170, heading "### Command Framework"):**

This section documents `CommandDefinition`, `CommandContext`, `CommandResult` interfaces. Update the introduction to note these are now only used for MCP bridge commands:

Add at the top of the section:
```markdown
> **Note:** The `CommandDefinition` framework is now used only for MCP bridge commands. Agent tools use the `RegisteredTool` pattern (see `docs/design/agent-system.md`). The following documentation applies to MCP bridge command dispatch only.
```

**2. createDefineCommands subsection (lines ~174-227, heading "### createDefineCommands"):**

Similarly add a note that this function now only processes MCP bridge `CommandDefinition` objects:

```markdown
> **Note:** `createDefineCommands()` now only processes MCP bridge commands. Native agent tools bypass this entirely and dispatch through the unified tool registry.
```

**3. End-to-end sandbox creation example (lines ~276, ~294, look for `createDefineCommands` calls in code examples):**

If the example shows `createDefineCommands` being called with built-in commands, update the example to show only MCP commands being passed.

**Commit:** `docs: update sandbox-and-llm.md to scope CommandDefinition to MCP bridge`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Update docs/design/architecture.md

**Verifies:** native-tools.AC7.3

**Files:**
- Modify: `docs/design/architecture.md`

**Implementation:**

**Line 193** currently says:
```
Tools from connected servers are exposed via subcommand dispatch: one `CommandDefinition` per MCP server (named by server, e.g. `github`), with a `subcommand` parameter selecting the individual tool...
```

Update to clarify this is MCP-specific and that native agent tools use a different mechanism:

```
Agent tools are implemented as native `RegisteredTool` factories with structured JSON schemas, dispatched through a unified tool registry. MCP server tools are exposed via subcommand dispatch through the bash sandbox: one `CommandDefinition` per MCP server (named by server, e.g. `github`), with a `subcommand` parameter selecting the individual tool...
```

**Commit:** `docs: update architecture.md for native tool dispatch`
<!-- END_TASK_6 -->

<!-- START_TASK_7 -->
### Task 7: Verify no stale references in active docs

**Files:** None (verification only)

**Implementation:**

Grep across active documentation files (excluding `docs/design/specs/` and `docs/implementation-plans/` which are historical records) for stale references:

```bash
grep -rn "CommandDefinition\|getAllCommands\|createDefineCommands\|Available Commands\|20+ built-in\|20 commands\|bash-dispatched command" \
  CLAUDE.md CONTRIBUTING.md README.md docs/design/*.md \
  --include="*.md" | grep -v "MCP\|bridge\|historical\|Note:"
```

Any remaining hits that aren't qualified as MCP-specific or historical should be updated.

**Verification:**
Run the grep command above
Expected: Zero unqualified references to old command dispatch in active docs

**Commit:** No commit — verification only. Fix any remaining references found.
<!-- END_TASK_7 -->
