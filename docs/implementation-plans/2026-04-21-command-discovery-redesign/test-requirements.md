# Test Requirements: Command Discovery Redesign

Maps each acceptance criterion from the [design plan](../../design-plans/2026-04-21-command-discovery-redesign.md) to specific tests or verification methods.

## AC1: `--help` works on every command

### AC1.1 -- `schedule --help` returns usage information

**Criterion:** `schedule --help` returns usage information (name, description, argument list) with exit code 0.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Create a `CommandDefinition` with `name: "schedule"`, `description: "Schedule a deferred task"`, and `args: [{ name: "task", required: true }]`. Invoke the dispatcher with `["--help"]`. Assert `exitCode === 0`, `stdout` contains `"schedule"`, `stdout` contains the description, `stdout` contains `"task"`. |

### AC1.2 -- `memory --help` returns subcommand listing via helpText override

**Criterion:** `memory --help` returns a subcommand listing (store / forget / search / connect / disconnect) with argument signatures, sourced from the command's `helpText` override.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 4, Task 2 |
| What the test validates | Create a test `CommandDefinition` with a `helpText` string containing subcommand listings (mirrors the real `memory` command's `helpText`). Invoke the dispatcher with `["--help"]`. Assert `exitCode === 0`, `stdout` contains `"Subcommands:"`, `stdout` contains all expected subcommand names (store, forget, search, connect, disconnect, traverse, neighbors). Also validates advisory's helpText rendering with the same pattern. Note: Uses test fixtures rather than importing real commands to avoid cross-package test dependencies. |

### AC1.3 -- `schedule -h` returns same output as `schedule --help`

**Criterion:** `schedule -h` returns the same output as `schedule --help`.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Same command fixture as AC1.1. Invoke the dispatcher with `["-h"]`. Assert output matches the `["--help"]` output exactly. |

### AC1.4 -- MCP `customHelp` commands pass `--help` through to their handler

**Criterion:** `atproto --help` returns the MCP bridge's dynamic subcommand enumeration (not the dispatcher's generic help), because the MCP command sets `customHelp: true` and the argv parser now populates `args.help = "true"` for a bare `--help` token.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Create a `CommandDefinition` with `customHelp: true` whose handler checks `args.help` and returns a custom response when `args.help === "true"`. Invoke the dispatcher with `["--help"]`. Assert the handler's custom response is returned (not `formatHelp` output). Also test with `["-h"]` and assert `args.help === "true"` in the handler. |

### AC1.5 -- `--help` with extra args does NOT trigger interception

**Criterion:** `schedule --help extra-arg` (i.e., `--help` with additional argv) does NOT trigger interception and passes through to normal argument parsing. Interception fires only when `argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")`.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Same non-`customHelp` command fixture. Invoke the dispatcher with `["--help", "extra-arg"]`. Assert the result is NOT the `formatHelp` output (should proceed to normal parsing where `--help` is consumed as a flag with `"extra-arg"` as its value, so `args.help === "extra-arg"`). |

### AC1.6 -- Bare `--flag` tokens resolve to `"true"`

**Criterion:** The argv parser populates `args[flag] = "true"` for any `--<flag>` token that is either the last in argv or immediately followed by another `--<flag>` (no value). Previously such tokens were silently dropped.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Create a command with `args: [{ name: "verbose", required: false }]`. Invoke the dispatcher with `["--verbose"]` (bare flag, no value). Assert handler receives `args.verbose === "true"`. Also test `["--flag1", "--flag2"]` and assert both resolve to `"true"`. |

---

## AC2: Missing-argument errors include a usage hint

### AC2.1 -- Missing-arg error includes `--help` hint

**Criterion:** Invoking `schedule` with no arguments returns stderr containing `Missing required argument:` AND `(run 'schedule --help' for usage)`.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Create a command with `args: [{ name: "task", required: true }]`. Invoke the dispatcher with `[]` (no arguments). Assert `exitCode === 1`, `stderr` contains `"Missing required argument: task"`, `stderr` contains `"(run 'schedule --help' for usage)"`. |

### AC2.2 -- Exit code remains 1

**Criterion:** Exit code in the missing-arg path remains 1 (unchanged from current behaviour).

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/sandbox/src/__tests__/commands.test.ts` |
| Implemented in | Phase 3, Task 3 |
| What the test validates | Same invocation as AC2.1. Assert `exitCode === 1`. This is tested within the same test case as AC2.1 (the assertion on `exitCode` covers both ACs). |

---

## AC3: Orientation block reflects the command registry

### AC3.1 -- Registered commands appear in the orientation block

**Criterion:** A command registered via `setCommandRegistry` appears in the orientation block's command list without any change to `context-assembly.ts`.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Integration |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |
| Implemented in | Phase 5, Task 3 |
| What the test validates | Call `setCommandRegistry` with a list containing a custom test command (e.g., `{ name: "test-cmd", description: "A test command", args: [], handler: ... }`). Then call `assembleContext()`. Find the orientation system message (contains `"## Orientation"`). Assert the output contains `"test-cmd — A test command"`. This proves new commands appear without editing `context-assembly.ts`. State is saved/restored in `afterEach` to avoid polluting other tests. |

### AC3.2 -- MCP commands appear alongside built-ins, sorted alphabetically

**Criterion:** MCP server-level commands appear in the orientation block's command list, sorted alphabetically alongside built-ins. (Test fixtures supply a representative MCP `CommandDefinition`; test asserts its name appears in the rendered list.)

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Integration |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |
| Implemented in | Phase 5, Task 3 |
| What the test validates | Call `setCommandRegistry` with a mix of built-in and MCP-style commands (e.g., `{ name: "atproto", description: "MCP server exposing 5 tools", customHelp: true, ... }` alongside `{ name: "query", description: "Execute a SELECT query", ... }`). Assert the orientation block contains both `"atproto"` and `"query"`, and that `"atproto"` appears before `"query"` (alphabetical sort). |

### AC3.3 -- Footer references `<cmd> --help`

**Criterion:** The orientation block's footer includes (literal backticks around `<cmd> --help`):
```
Run `<cmd> --help` for details on any command.
```
replacing the current reference to the `commands` command / `commands <name>`.

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Integration |
| Test file | `packages/agent/src/__tests__/context-assembly.test.ts` |
| Implemented in | Phase 5, Task 3 |
| What the test validates | Assert the orientation block contains the literal string `` Run `<cmd> --help` for details on any command. ``. Assert it does NOT contain `"commands <name>"` or `` "Run `commands`" ``. |

### AC3.4 -- Missing `description` is a compile error

**Criterion:** Registering a `CommandDefinition` without a `description` field is a TypeScript compile error.

| Attribute | Value |
|---|---|
| Verification | Compile-time enforcement (typecheck) |
| Test type | N/A (not a runtime test) |
| Test file | N/A |
| Implemented in | Phase 1, Task 1 |
| Verification approach | The `description` field is declared as `description: string` (required) on the `CommandDefinition` interface. `bun run typecheck` must pass with zero errors after all 21 built-in commands add descriptions. Any future `CommandDefinition` export missing `description` will fail typecheck in CI. |
| Justification for non-automation | This is a structural type constraint enforced by the TypeScript compiler. A runtime test would be redundant — the code cannot compile without the field. The CI typecheck (`bun run typecheck`) is the automated verification gate. |

---

## AC4: The `commands` command is removed

### AC4.1 -- Invoking `commands` returns not-found

**Criterion:** Invoking `commands` returns `command not found` (or equivalent dispatcher not-found error).

| Attribute | Value |
|---|---|
| Verification | Automated test |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/commands.test.ts` |
| Implemented in | Phase 6, Task 3 |
| What the test validates | Import `getAllCommands` from `../commands/index`. Assert no entry in the returned array has `name === "commands"`. This is a sufficient proxy for the AC because if `commands` is absent from `getAllCommands()`, the dispatcher will not register it, and the not-found path is already covered by existing dispatcher tests. The entire `describe("commands command", ...)` test suite (lines 968-1145 in the original file) is deleted since its subject no longer exists. |

### AC4.2 -- No `commands` export in registry.ts

**Criterion:** `packages/agent/src/commands/registry.ts` (renamed from `help.ts` in Phase 6) no longer exports a `CommandDefinition` named `commands`; `setCommandRegistry` and `getCommandRegistry` remain exported for other callers.

| Attribute | Value |
|---|---|
| Verification | Automated test + static grep |
| Test type | Unit |
| Test file | `packages/agent/src/__tests__/commands.test.ts` |
| Implemented in | Phase 6, Task 3 |
| What the test validates | Import `* as registry` from `../commands/registry`. Assert `registry` does NOT have a `help` property (the old export variable name). Assert `registry.setCommandRegistry` and `registry.getCommandRegistry` are functions. |
| Static verification | `grep -rn "name: \"commands\"" packages/` returns empty. `grep -rn "commands/help" packages/` returns empty (all importers migrated to `commands/registry`). Both greps are run as part of the Phase 6 done-when checks. |

---

## Summary

| AC | Criterion | Verification | Test file | Phase |
|---|---|---|---|---|
| AC1.1 | `schedule --help` returns usage info | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC1.2 | `memory --help` returns subcommand listing | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 4 |
| AC1.3 | `-h` works same as `--help` | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC1.4 | `customHelp` commands get `args.help` | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC1.5 | `--help extra-arg` skips interception | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC1.6 | Bare `--flag` resolves to `"true"` | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC2.1 | Missing-arg error includes hint | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC2.2 | Exit code remains 1 | Automated (unit) | `packages/sandbox/src/__tests__/commands.test.ts` | 3 |
| AC3.1 | Registered commands appear in orientation | Automated (integration) | `packages/agent/src/__tests__/context-assembly.test.ts` | 5 |
| AC3.2 | MCP commands sorted alongside built-ins | Automated (integration) | `packages/agent/src/__tests__/context-assembly.test.ts` | 5 |
| AC3.3 | Footer says `<cmd> --help` | Automated (integration) | `packages/agent/src/__tests__/context-assembly.test.ts` | 5 |
| AC3.4 | Missing `description` is compile error | Typecheck (`bun run typecheck`) | N/A | 1 |
| AC4.1 | `commands` returns not-found | Automated (unit) | `packages/agent/src/__tests__/commands.test.ts` | 6 |
| AC4.2 | No `commands` export in registry.ts | Automated (unit) + static grep | `packages/agent/src/__tests__/commands.test.ts` | 6 |

**Coverage:** 13 of 14 ACs are covered by automated runtime tests. AC3.4 is enforced at compile time by the TypeScript type system and verified by the CI typecheck step. No ACs require manual/human-only verification.
