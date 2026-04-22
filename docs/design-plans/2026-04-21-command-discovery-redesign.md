# Command Discovery Redesign

## Summary

The sandbox shell has two overlapping, partially-broken paths for command discovery: a hand-maintained list in `context-assembly.ts` rendered into every thread's system prompt, and a `commands` built-in that enumerates commands and shows per-command details at runtime. Neither path supports the POSIX-idiomatic `<cmd> --help` convention on built-in commands, so the agent repeatedly tries `schedule --help` or `memory --help` and gets `Missing required argument` errors with no usage hint.

This design consolidates discovery onto two axes: **enumeration** moves entirely into the orientation block, auto-generated from the `CommandDefinition` registry at sandbox boot (replacing the hand-maintained list). **Per-command usage** moves entirely onto `<cmd> --help`, intercepted at the dispatcher level for every built-in, with an opt-out flag for MCP commands that handle their own richer `--help` dynamically. Missing-argument errors grow a `(run '<name> --help' for usage)` hint to point users at the right path. The `commands` command is deleted — its remaining use cases are all subsumed. MCP server-level commands appear in the orientation list alongside built-ins.

## Definition of Done

- Every registered sandbox command responds to `<cmd> --help` and `<cmd> -h` with usage information; no built-in command returns `Missing required argument` when `--help` is the only argument.
- Built-in commands' missing-argument errors include a hint pointing to `<cmd> --help`.
- The orientation block's command list is auto-generated from the `CommandDefinition` registry at sandbox boot; `AVAILABLE_COMMANDS` is removed.
- MCP server-level commands appear in the orientation block alongside built-ins.
- The `commands` command is removed from the sandbox (hard rename, no shim).
- Existing MCP `--help` behaviour (dynamic subcommand enumeration via the MCP client) is preserved unchanged.

## Acceptance Criteria

### command-discovery-redesign.AC1: `--help` works on every command
- **command-discovery-redesign.AC1.1 Success:** `schedule --help` returns usage information (name, description, argument list) with exit code 0.
- **command-discovery-redesign.AC1.2 Success:** `memory --help` returns a subcommand listing (store / forget / search / connect / disconnect) with argument signatures, sourced from the command's `helpText` override.
- **command-discovery-redesign.AC1.3 Success:** `schedule -h` returns the same output as `schedule --help`.
- **command-discovery-redesign.AC1.4 Success:** `atproto --help` returns the MCP bridge's dynamic subcommand enumeration (not the dispatcher's generic help), because the MCP command sets `customHelp: true` and the argv parser now populates `args.help = "true"` for a bare `--help` token.
- **command-discovery-redesign.AC1.5 Edge:** `schedule --help extra-arg` (i.e., `--help` with additional argv) does NOT trigger interception and passes through to normal argument parsing. Interception fires only when `argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")`.
- **command-discovery-redesign.AC1.6 Success:** The argv parser populates `args[flag] = "true"` for any `--<flag>` token that is either the last in argv or immediately followed by another `--<flag>` (no value). Previously such tokens were silently dropped.

### command-discovery-redesign.AC2: Missing-argument errors include a usage hint
- **command-discovery-redesign.AC2.1 Success:** Invoking `schedule` with no arguments returns stderr containing `Missing required argument:` AND `(run 'schedule --help' for usage)`.
- **command-discovery-redesign.AC2.2 Success:** Exit code in the missing-arg path remains 1 (unchanged from current behaviour).

### command-discovery-redesign.AC3: Orientation block reflects the command registry
- **command-discovery-redesign.AC3.1 Success:** A command registered via `setCommandRegistry` appears in the orientation block's command list without any change to `context-assembly.ts`.
- **command-discovery-redesign.AC3.2 Success:** MCP server-level commands appear in the orientation block's command list, sorted alphabetically alongside built-ins. (Test fixtures supply a representative MCP `CommandDefinition`; test asserts its name appears in the rendered list.)
- **command-discovery-redesign.AC3.3 Success:** The orientation block's footer includes (literal backticks around `<cmd> --help`):

  ```
  Run `<cmd> --help` for details on any command.
  ```

  replacing the current reference to the `commands` command / `commands <name>`.
- **command-discovery-redesign.AC3.4 Failure:** Registering a `CommandDefinition` without a `description` field is a TypeScript compile error.

### command-discovery-redesign.AC4: The `commands` command is removed
- **command-discovery-redesign.AC4.1 Failure:** Invoking `commands` returns `command not found` (or equivalent dispatcher not-found error).
- **command-discovery-redesign.AC4.2 Success:** `packages/agent/src/commands/registry.ts` (renamed from `help.ts` in Phase 6) no longer exports a `CommandDefinition` named `commands`; `setCommandRegistry` and `getCommandRegistry` remain exported for other callers.

## Glossary

- **CommandDefinition:** The interface (in `packages/sandbox/src/commands.ts`) used to register a shell command in the sandbox dispatch table. Carries `name`, arg schema, and `handler`. This design adds `description` (required), `helpText?` (override for auto-generated help), and `customHelp?` (opt-out flag).
- **Dispatcher:** The closure built by `createDefineCommands` in `packages/sandbox/src/commands.ts` that wraps each `CommandDefinition.handler` with argv parsing and validation. Runs inside the sandboxed shell.
- **Orientation block:** The system-prompt section prepended to every thread in `packages/agent/src/context-assembly.ts`, enumerating available sandbox commands. Today hand-maintained as `AVAILABLE_COMMANDS`; this design makes it registry-driven.
- **MCP bridge:** `packages/agent/src/mcp-bridge.ts`, which exposes MCP server tools as sandbox commands. Each MCP server appears as one top-level command (e.g., `atproto`) that subcommand-dispatches to the server's tools.
- **MCP proxy commands:** Remote MCP commands exposed via `generateRemoteMCPProxyCommands`. Same `--help` contract as direct MCP commands; also opt-out.
- **Subcommand-dispatched built-in:** A built-in command that takes a single positional `subcommand` argument and routes internally (e.g., `memory`, `advisory`). These need `helpText` overrides because the auto-generated help from `args` can't enumerate subcommand values.
- **Hard rename:** Project convention for command renames — remove the old name immediately with no deprecation alias. Cron prompts / memory entries referencing the old name fail with `command not found` on their next run and self-correct. Chosen over shims to avoid carrying legacy naming forward.

## Architecture

Command discovery in this design has two layers, each with one path:

**Enumeration layer** — the orientation block. At sandbox boot, `setCommandRegistry` receives the full list of registered `CommandDefinition`s (built-ins + MCP server commands + MCP proxy commands). A new `getCommandRegistry()` export in `packages/agent/src/commands/registry.ts` (the file is named `help.ts` today; renamed in Phase 6 to match its post-deletion contents) exposes that list to `context-assembly.ts`, which renders it as `  <name> — <description>` lines in the orientation block, sorted alphabetically. The hand-maintained `AVAILABLE_COMMANDS` constant is removed.

**Per-command-usage layer** — `<cmd> --help`. The dispatcher wrapper in `createDefineCommands` intercepts `--help` / `-h` when they are the sole argv element, returning output from a new `formatHelp(def)` utility. Built-ins render from the `args` schema unless they provide a `helpText` string override. MCP commands set `customHelp: true` on their `CommandDefinition` to opt out of interception; the dispatcher passes `--help` through to their handler, which owns dynamic subcommand enumeration via the live MCP client.

Missing-argument errors in the dispatcher grow a single-line hint pointing at `<cmd> --help`, so any command path that fails with `Missing required argument: X` also reminds the caller where to find usage.

The `commands` command's `CommandDefinition` is deleted from `packages/agent/src/commands/help.ts` and unregistered in `packages/agent/src/commands/index.ts`. `setCommandRegistry` and `getCommandRegistry` remain — they are load-bearing for orientation block assembly, but no longer backing a user-facing `commands` command.

### Contracts

**`CommandDefinition` — extended interface** in `packages/sandbox/src/commands.ts`:

```typescript
export interface CommandDefinition {
  name: string;
  description: string;      // NEW: required one-line summary for orientation block + auto-help
  helpText?: string;        // NEW: optional multi-line help body; overrides auto-generated help
  customHelp?: boolean;     // NEW: when true, dispatcher does NOT intercept --help / -h
  args: Array<{ name: string; required: boolean; description?: string }>;
  handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}
```

**`formatHelp` contract** in `packages/sandbox/src/commands.ts`:

```typescript
function formatHelp(def: CommandDefinition): CommandResult;
// Returns { stdout: <help-text>, stderr: "", exitCode: 0 }.
// Output shape:
//   <name> — <description>
//
//   <helpText if present, else auto-generated Usage + Arguments sections>
```

**`getCommandRegistry` export** in `packages/agent/src/commands/registry.ts` (renamed from `help.ts` in Phase 6):

```typescript
export function getCommandRegistry(): readonly CommandDefinition[];
// Returns the module-level registry populated by setCommandRegistry at boot.
// Returns [] before boot; context-assembly must run after setCommandRegistry.
```

## Existing Patterns

Investigation found existing patterns that this design follows:

- **Command registration** via `CommandDefinition` objects passed to `createDefineCommands`, collected at sandbox boot by `setCommandRegistry` — see `packages/cli/src/commands/start/sandbox.ts:80`. This design preserves the registration path and augments it with a getter for context assembly.
- **MCP bridge `--help` handling** at `packages/agent/src/mcp-bridge.ts:174-228`. Handles both `--help` flag and `help` subcommand (LLM convention). This design preserves that handler by opting MCP commands out of dispatcher interception via `customHelp: true`.
- **System prompt / orientation assembly** in `packages/agent/src/context-assembly.ts` line 1000, which renders `AVAILABLE_COMMANDS` via `map(c => \`  ${c.name} — ${c.description}\`).join("\n")`. This design swaps the source array and adds a sort step; the rendering template is unchanged.
- **Hard-rename pattern** for command renames: no deprecation shim, cron prompts referencing the old name fail on next run and self-correct. This design follows that convention for removing `commands`.
- **MCP proxy command factory** (`generateRemoteMCPProxyCommands`) produces the same `CommandDefinition` shape as direct MCP commands. Both sites set `customHelp: true`.

This design extends the existing `CommandDefinition` interface with three new fields (`description`, `helpText?`, `customHelp?`) and adds dispatcher-level `--help` handling. No new registration or dispatch patterns — the extensions flow through existing plumbing.

## Implementation Phases

<!-- START_PHASE_1 -->
### Phase 1: Extend CommandDefinition and populate descriptions

**Goal:** Atomic change that lands the new interface and populates every built-in's `description`, so the tree leaves this phase with a clean typecheck.

**Components:**
- `CommandDefinition` interface in `packages/sandbox/src/commands.ts` (lines 49-53) — add three new fields per the contract above (`description: string`, `helpText?: string`, `customHelp?: boolean`).
- Every `CommandDefinition` export in `packages/agent/src/commands/*.ts` — `query.ts`, `memory.ts`, `advisory.ts`, `schedule.ts`, `cancel.ts`, `emit.ts`, `purge.ts`, `await-cmd.ts`, `cache-warm.ts`, `cache-pin.ts`, `cache-unpin.ts`, `cache-evict.ts`, `model-hint.ts`, `archive.ts`, `hostinfo.ts`, `notify.ts`, `skill-activate.ts`, `skill-list.ts`, `skill-read.ts`, `skill-retire.ts`. Copy description strings from the current `AVAILABLE_COMMANDS` constant in `context-assembly.ts:276-302`; for any command not represented there (e.g., `notify` may be missing), write a one-line description matching the style.

**Covers ACs:** command-discovery-redesign.AC3.4 (the required `description: string` field makes AC3.4 a TypeScript-level invariant; the Done-when clean typecheck proves it holds).

**Dependencies:** None (first phase).

**Done when:** `bun run typecheck` passes. No `CommandDefinition` is missing a `description` field. Attempting to register a `CommandDefinition` without `description` produces a TypeScript compile error.
<!-- END_PHASE_1 -->

<!-- START_PHASE_2 -->
### Phase 2: MCP command descriptions and customHelp opt-out

**Goal:** MCP server-level and proxy commands carry a spec-sourced `description` and set `customHelp: true` so the Phase 3 dispatcher interception skips them.

**Components:**
- `packages/agent/src/mcp-bridge.ts` server-level command factory (construction site for per-server `CommandDefinition`; see function near line 148) — add `description` sourced from the MCP `InitializeResult` in this order:
  1. `serverInfo.description` (per [MCP spec](https://github.com/modelcontextprotocol/modelcontextprotocol) — `Implementation.description`, an optional human-readable description of what the server does). Primary path; purpose-built field.
  2. `instructions` (also on `InitializeResult`, describing how to use the server) trimmed to first sentence. Fallback when `description` is absent.
  3. Synthesized `"MCP server exposing N tools: <tool, tool, …>"` — computed at registration from the dispatch table. Last-resort fallback when neither spec field is provided.
  All three paths cap the resulting string at 80 characters, truncating with `…` to keep the orientation block's `  name — description` lines visually consistent.
  Also set `customHelp: true` so dispatcher interception skips these commands.
- `generateRemoteMCPProxyCommands` in the same file — same description sourcing chain (with 80-char cap) and `customHelp: true`.

**Dependencies:** Phase 1.

**Done when:** `bun run typecheck` passes. Booting a sandbox with an MCP server registered produces a `CommandDefinition` with `description` non-empty (from one of the three sources above) and `customHelp === true`.
<!-- END_PHASE_2 -->

<!-- START_PHASE_3 -->
### Phase 3: Dispatcher `--help` interception, argv parser fix, and missing-arg hint

**Goal:** Every built-in responds to `<cmd> --help` / `-h` with usage output; MCP commands receive `--help` in a form their handler recognizes (`args.help === "true"`); missing-arg errors include a hint.

**Components:**
- `formatHelp` utility in `packages/sandbox/src/commands.ts` — new function; renders `<name> — <description>`, then either `helpText` verbatim or an auto-generated `Usage:` + `Arguments:` section from the `args` schema. Returns `{ stdout, stderr: "", exitCode: 0 }`.
- Interception in `createDefineCommands` in the same file — inserted at the top of the dispatcher closure, before argv parsing begins. Fires only when `!def.customHelp && argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")`.
- Argv flag parser fix in `createDefineCommands` (the `hasFlags` branch, lines ~65-82) — when a `--<flag>` token is the last in argv OR is immediately followed by another `--<flag>` (i.e., no value follows), treat it as a bare boolean and set `args[flag] = "true"`. Narrow fix scoped to enable `--help` propagation into MCP handlers; arguably a pre-existing bug since bare `--flag` tokens are currently dropped silently. Also alias `-h` to `args.help = "true"` so the short form works uniformly through the MCP `customHelp` path.
- Missing-arg error message in `createDefineCommands` (current stderr at line ~101) — append `(run '<name> --help' for usage)\n`.

**Covers ACs:** command-discovery-redesign.AC1.1, AC1.3, AC1.4, AC1.5, AC1.6, AC2.1, AC2.2.

**Dependencies:** Phases 1-2 (requires interface + descriptions + MCP opt-out flag).

**Done when:** New tests in `packages/sandbox/src/__tests__/commands.test.ts` (or equivalent new file) verify AC1.1, AC1.3, AC1.4, AC1.5, AC1.6, AC2.1, AC2.2 and all pass. `bun run typecheck` passes.
<!-- END_PHASE_3 -->

<!-- START_PHASE_4 -->
### Phase 4: helpText overrides for subcommand-dispatched built-ins

**Goal:** `memory --help`, `advisory --help`, and any skill-* variant that dispatches on a `subcommand` arg return a rich subcommand listing instead of the auto-generated stub.

**Components:**
- `memory.ts`, `advisory.ts` in `packages/agent/src/commands/` — add `helpText` to the `CommandDefinition`, content sourced from the current `commands <name>` output in `help.ts` (so the agent sees no regression between `commands memory` and `memory --help`).
- Any skill-* command with a `subcommand` arg (verify during implementation) — same treatment.

**Covers ACs:** command-discovery-redesign.AC1.2.

**Dependencies:** Phase 3 (requires the `helpText` path in `formatHelp` to be live).

**Done when:** Test for AC1.2 in `packages/sandbox/src/__tests__/commands.test.ts` (or a new test file for built-ins) passes. `memory --help` output is a superset of the current `commands memory` output.
<!-- END_PHASE_4 -->

<!-- START_PHASE_5 -->
### Phase 5: Auto-generated orientation block

**Goal:** The orientation block's command list comes from the live registry; new commands (including MCP commands) show up without touching `context-assembly.ts`.

**Components:**
- `getCommandRegistry` export in `packages/agent/src/commands/help.ts` — new function returning the module-level `commandRegistry`. (Phase 6 renames this file to `registry.ts`; importers added here update in Phase 6 accordingly.)
- `packages/agent/src/context-assembly.ts` — delete the `AVAILABLE_COMMANDS` constant (lines 276-302); replace the rendering line (around line 1000) with a call to `getCommandRegistry()` sorted by `name`. Update the footer text immediately below the list to the literal string (with backticks):

  ```
  Run `<cmd> --help` for details on any command.
  ```

**Covers ACs:** command-discovery-redesign.AC3.1, AC3.2, AC3.3.

**Dependencies:** Phases 1-2 (every command in the registry must have a `description`).

**Done when:** New tests in `packages/agent/src/__tests__/context-assembly.test.ts` (or equivalent new file) verify AC3.1, AC3.2, AC3.3 and all pass.
<!-- END_PHASE_5 -->

<!-- START_PHASE_6 -->
### Phase 6: Delete the `commands` command and rename help.ts → registry.ts

**Goal:** Hard removal of the `commands` command. Discovery flows through orientation block + `<cmd> --help` only. The remaining module contents (registry accessors) move to a file that matches their purpose.

**Components:**
- `packages/agent/src/commands/help.ts` — delete the `export const help: CommandDefinition = { name: "commands", ... }` block. Keep `setCommandRegistry`, `getCommandRegistry`, and their supporting module state (`commandRegistry`, `serverNamesRegistry`, `remoteServerNamesRegistry`).
- Rename `packages/agent/src/commands/help.ts` → `packages/agent/src/commands/registry.ts`. Update all importers:
  - `packages/agent/src/commands/index.ts` — import path and remove the `help` symbol from the import list (keep `setCommandRegistry`). Also remove `help` from the `getAllCommands()` return array. Add `getCommandRegistry` to the re-export block if downstream modules import it via the barrel.
  - `packages/agent/src/context-assembly.ts` — the Phase 5 `getCommandRegistry` import updates to the new path.
  - Any other importer surfaced by `grep -rn "commands/help" packages/` during implementation.
- `docs/` and any cron-prompt sources in the repo — grep pass `grep -rn "'commands'\|\"commands\"\|run \`commands\`\|commands [a-z]" docs/ packages/ 2>/dev/null`; replace remaining user-visible references with `<cmd> --help` guidance. Memory entries and live cron prompts outside the repo are NOT pre-updated — per hard-rename convention, they self-correct on next run.

**Covers ACs:** command-discovery-redesign.AC4.1, AC4.2.

**Dependencies:** Phase 5 (orientation block must already be sourcing from the registry, not from a path that goes through the `commands` command).

**Done when:** Test for AC4.1 (invoking `commands` returns not-found) passes. `grep -n "name: \"commands\"" packages/` is empty. `grep -n "commands/help" packages/` is empty (all importers migrated to `commands/registry`). Grep pass in docs completes with no remaining user-facing references to the `commands` command as a runtime path.
<!-- END_PHASE_6 -->

## Additional Considerations

**Rollback:** Single-PR revert. No schema changes, no data migrations, no external API changes. Cron prompts / memory entries that learned `<cmd> --help` during this change continue to work post-revert (the pre-change code returned `Missing required argument` for `--help`, which is the same failure shape cron prompts already tolerated).

**Cron prompts referencing `commands`:** Per hard-rename convention, these are not pre-updated. The first post-deploy run returns `command not found`; the prompt author (often me, via heartbeat's feedback loop) updates the prompt.

**MCP commands shown when server is offline:** MCP server-level `CommandDefinition`s are registered at sandbox boot regardless of live-connection status; the dispatch handler checks connection state at call time and returns a connection error if the server is unreachable. The orientation block will list offline MCP commands; the agent discovers the offline state only on first invocation. Acceptable — matches current behaviour and surfacing-at-call-time is consistent with how disconnection is already communicated.

**Late-registered remote MCP servers:** The current `commands` command (`help.ts:84-104`) DB-queries `hosts.mcp_tools` at call time to surface remote MCP servers discovered AFTER sandbox boot (servers not in `remoteServerNamesRegistry` because they came online via relay later in the session). After this design, the orientation block renders from `getCommandRegistry()` — a snapshot from boot — and does not re-query the hosts table. Consequence: a remote MCP server that registers mid-session is invisible in the orientation block of threads started before the registration. Accepted regression: orientation is re-rendered per-thread, so the next thread started (or next sandbox restart) picks up the updated registry; mid-session remote-server registration is rare. The alternative — duplicating the DB fallback inside `getCommandRegistry()` — splits the "what commands are available" source of truth across two paths and is deliberately declined. If the regression bites in practice, a follow-up PR can re-trigger `setCommandRegistry` on host-table updates, which is the cleaner resolution than per-call DB queries.

**Per-server curated MCP descriptions:** Phase 2 sources descriptions from MCP spec fields with a synthesized last-resort fallback. If, in practice, the spec fields are underpopulated across the MCP ecosystem and the synthesized fallback reads poorly in the orientation block, a follow-up PR can add an optional curated-description field to bound's MCP client config. Deliberately out of scope here — the spec-driven chain is tried first before adding config surface.

**`-h` in addition to `--help`:** Supporting both. Cost is trivial (one extra OR branch in interception) and POSIX/GNU convention expects both. Flag if preference differs during review.
