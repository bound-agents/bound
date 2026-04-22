# Command Discovery Redesign - Human Test Plan

## Prerequisites
- Working Bun installation with `bun install` completed
- All automated tests passing: `bun test packages/sandbox/src/__tests__/commands.test.ts` and `bun test packages/agent/src/__tests__/commands.test.ts` and `bun test packages/agent/src/__tests__/context-assembly.test.ts`
- Typecheck passing: `bun run typecheck`
- Local bound instance runnable via `bun packages/cli/src/bound.ts start` from `~/bound/`

## Phase 1: Typecheck Verification (AC3.4)

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | Run `bun run typecheck` from the worktree root | Zero errors across all packages |
| 1.2 | Temporarily remove `description` from any `CommandDefinition` in `packages/agent/src/commands/` (e.g., `query.ts`) and run `tsc -p packages/agent --noEmit` | TypeScript reports a compile error about missing `description` property |
| 1.3 | Revert the change from 1.2 | Typecheck passes again |

## Phase 2: Static Verification (AC4.2 supplement)

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | Run `grep -rn 'name: "commands"' packages/` from the worktree root | No output (no file registers a command named `commands`) |
| 2.2 | Run `grep -rn 'commands/help' packages/` from the worktree root | No output (all importers migrated from `help.ts` to `registry.ts`) |
| 2.3 | Verify `packages/agent/src/commands/help.ts` does not exist | File not found |

## Phase 3: Live Agent Smoke Test

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Start the agent: `cd ~/bound && bun packages/cli/src/bound.ts start` | Agent starts without errors |
| 3.2 | Send a message to the agent asking it to run `schedule --help` | Agent returns a formatted usage block containing the command name `schedule`, its description, and its argument list (including `in`, `every`, `on`, `payload`) with exit code 0 |
| 3.3 | Send a message asking the agent to run `memory --help` | Agent returns subcommand listing including store, forget, search, connect, disconnect, traverse, neighbors |
| 3.4 | Send a message asking the agent to run `commands` | Agent returns a "command not found" or equivalent not-found error |
| 3.5 | Send a message asking the agent to run `advisory -h` | Agent returns advisory subcommand listing including create, list, approve, apply, dismiss, defer |
| 3.6 | Send a message asking the agent to run `query --help` | Agent returns usage info for the query command |

## Phase 4: Orientation Block Inspection

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Start a new thread with the agent. Ask: "What commands are available to you?" | The agent's response should list commands drawn from the orientation block. All built-in commands (schedule, memory, query, purge, emit, cancel, advisory, etc.) and any MCP commands should be present. The list should be alphabetically sorted. |
| 4.2 | In the context debug output (if available via web UI at `http://localhost:3001`), inspect the system message containing `## Orientation` | The orientation block contains a command list with `name --- description` entries. Footer reads `` Run `<cmd> --help` for details on any command. `` and does NOT mention `commands <name>`. |

## End-to-End: Command Discovery Flow

**Purpose:** Validates the complete user journey from discovering available commands to getting detailed help on a specific one, replacing the old `commands` command workflow.

| Step | Action | Expected |
|------|--------|----------|
| E2E.1 | Start a fresh thread with the agent | Agent receives orientation block with command list and `--help` footer |
| E2E.2 | Ask the agent "What can you do?" | Agent references its command list from the orientation block, mentioning several commands by name |
| E2E.3 | Ask the agent to run `schedule --help` | Agent invokes the command dispatcher, receives formatted help output, and relays it. Output includes usage line, argument descriptions, and exit code 0 |
| E2E.4 | Ask the agent to schedule a task: "schedule a task in 5 minutes with payload {\"test\": true}" | Agent successfully creates the task (verifies that normal `schedule` usage is unaffected by the `--help` interception) |
| E2E.5 | Ask the agent to run `memory --help` | Agent receives the subcommand listing from `helpText`, not generic formatHelp output |
| E2E.6 | If MCP servers are configured, ask the agent to run `<mcp-server-name> --help` | Agent receives dynamic subcommand enumeration from the MCP bridge handler (customHelp path), not the generic formatHelp |

## Human Verification Required

| Criterion | Why Manual | Steps |
|-----------|------------|-------|
| AC3.4 -- Missing `description` is compile error | Type system enforcement cannot be tested at runtime; requires attempting an invalid compile | Phase 1, steps 1.1-1.3 |
| Help text readability | Automated tests verify content presence but not formatting quality | Phase 3, steps 3.2-3.6: visually inspect that help output is well-formatted with clear alignment, proper line breaks, and readable argument descriptions |
| Orientation block completeness | Automated tests use minimal fixtures; live run exercises the full 20+ command registry | Phase 4, step 4.1-4.2: verify all expected commands appear and none are duplicated or missing descriptions |
| MCP customHelp end-to-end | Requires a running MCP server to validate the full bridge path | E2E step E2E.6: only possible if an MCP server is configured in the test environment |

## Traceability

| Acceptance Criterion | Automated Test | Manual Step |
|----------------------|----------------|-------------|
| AC1.1 `schedule --help` returns usage | sandbox/commands.test.ts "AC1.1" | Phase 3, step 3.2 |
| AC1.2 `memory --help` returns subcommands | sandbox/commands.test.ts "AC1.2" | Phase 3, step 3.3 |
| AC1.3 `-h` same as `--help` | sandbox/commands.test.ts "AC1.3" | Phase 3, step 3.5 |
| AC1.4 `customHelp` gets `args.help` | sandbox/commands.test.ts "AC1.4" | E2E step E2E.6 |
| AC1.5 `--help extra-arg` skips interception | sandbox/commands.test.ts "AC1.5" | -- |
| AC1.6 Bare `--flag` resolves to `"true"` | sandbox/commands.test.ts "AC1.6" | -- |
| AC2.1 Missing-arg error includes hint | sandbox/commands.test.ts "AC2.1" | -- |
| AC2.2 Exit code remains 1 | sandbox/commands.test.ts "AC2.2" | -- |
| AC3.1 Registered commands in orientation | context-assembly.test.ts "AC3.1" | Phase 4, step 4.1 |
| AC3.2 MCP commands sorted alphabetically | context-assembly.test.ts "AC3.2" | Phase 4, step 4.2 |
| AC3.3 Footer says `<cmd> --help` | context-assembly.test.ts "AC3.3" | Phase 4, step 4.2 |
| AC3.4 Missing `description` is compile error | `bun run typecheck` | Phase 1, steps 1.1-1.3 |
| AC4.1 `commands` returns not-found | agent/commands.test.ts "AC4.1" | Phase 3, step 3.4 |
| AC4.2 No `commands` export in registry | agent/commands.test.ts "AC4.2" | Phase 2, steps 2.1-2.3 |
