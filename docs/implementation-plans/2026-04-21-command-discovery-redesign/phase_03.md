# Command Discovery Redesign Implementation Plan

**Goal:** Every built-in command responds to `<cmd> --help` / `-h` with usage output; MCP commands receive `--help` as `args.help = "true"` for their dynamic handler; missing-argument errors include a hint pointing to `--help`.

**Architecture:** A `formatHelp` utility renders help text from a `CommandDefinition`. The dispatcher closure in `createDefineCommands` intercepts `--help`/`-h` as sole argv before parsing begins (skipped for `customHelp: true`). The argv flag parser gets a bare-flag fix so `--flag` tokens without a value resolve to `"true"` instead of being silently dropped. Missing-arg errors grow a one-line hint.

**Tech Stack:** TypeScript 6.x, Bun monorepo, `packages/sandbox/src/commands.ts`

**Scope:** 6 phases from original design (phases 1-6). This is phase 3 of 6.

**Codebase verified:** 2026-04-21

---

## Acceptance Criteria Coverage

This phase implements and tests:

### command-discovery-redesign.AC1: `--help` works on every command
- **command-discovery-redesign.AC1.1 Success:** `schedule --help` returns usage information (name, description, argument list) with exit code 0.
- **command-discovery-redesign.AC1.3 Success:** `schedule -h` returns the same output as `schedule --help`.
- **command-discovery-redesign.AC1.4 Success:** `atproto --help` returns the MCP bridge's dynamic subcommand enumeration (not the dispatcher's generic help), because the MCP command sets `customHelp: true` and the argv parser now populates `args.help = "true"` for a bare `--help` token.
- **command-discovery-redesign.AC1.5 Edge:** `schedule --help extra-arg` (i.e., `--help` with additional argv) does NOT trigger interception and passes through to normal argument parsing. Interception fires only when `argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")`.
- **command-discovery-redesign.AC1.6 Success:** The argv parser populates `args[flag] = "true"` for any `--<flag>` token that is either the last in argv or immediately followed by another `--<flag>` (no value). Previously such tokens were silently dropped.

### command-discovery-redesign.AC2: Missing-argument errors include a usage hint
- **command-discovery-redesign.AC2.1 Success:** Invoking `schedule` with no arguments returns stderr containing `Missing required argument:` AND `(run 'schedule --help' for usage)`.
- **command-discovery-redesign.AC2.2 Success:** Exit code in the missing-arg path remains 1 (unchanged from current behaviour).

---

<!-- START_SUBCOMPONENT_A (tasks 1-3) -->
<!-- START_TASK_1 -->
### Task 1: Add formatHelp utility and --help interception to the dispatcher

**Verifies:** command-discovery-redesign.AC1.1, command-discovery-redesign.AC1.3, command-discovery-redesign.AC1.5

**Files:**
- Modify: `packages/sandbox/src/commands.ts:49-154`

**Implementation:**

**Step 1: Add `formatHelp` function.**

Add this exported function after the `CommandDefinition` interface (after line 53, before `createDefineCommands`):

```typescript
/**
 * Render usage help for a command.
 * If helpText is provided, uses it verbatim; otherwise auto-generates from args schema.
 */
export function formatHelp(def: CommandDefinition): CommandResult {
	let body: string;
	if (def.helpText) {
		body = def.helpText;
	} else {
		const lines: string[] = [];
		// Usage line
		const argSyntax = def.args
			.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
			.join(" ");
		lines.push(`Usage: ${def.name}${argSyntax ? " " + argSyntax : ""}`);
		// Arguments section
		if (def.args.length > 0) {
			lines.push("");
			lines.push("Arguments:");
			for (const a of def.args) {
				const req = a.required ? "(required)" : "(optional)";
				lines.push(`  ${a.name} ${req}${a.description ? " — " + a.description : ""}`);
			}
		}
		body = lines.join("\n");
	}

	return {
		stdout: `${def.name} — ${def.description}\n\n${body}\n`,
		stderr: "",
		exitCode: 0,
	};
}
```

**Step 2: Add `--help`/`-h` interception to the dispatcher closure.**

In `createDefineCommands`, at the very top of the `handler` closure (line 60, after `const handler = async (argv: string[]) => {`), insert BEFORE the `const args` line:

```typescript
// --help / -h interception: sole argv, non-customHelp commands only
if (
	!def.customHelp &&
	argv.length === 1 &&
	(argv[0] === "--help" || argv[0] === "-h")
) {
	return formatHelp(def);
}
```

This intercepts before any argv parsing occurs. When `argv.length !== 1` (AC1.5), parsing proceeds normally.

**Commit:** Do not commit yet — Tasks 2 and 3 complete the phase.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Fix bare --flag parsing and add missing-arg hint

**Verifies:** command-discovery-redesign.AC1.4, command-discovery-redesign.AC1.6, command-discovery-redesign.AC2.1, command-discovery-redesign.AC2.2

**Files:**
- Modify: `packages/sandbox/src/commands.ts:70-104` (the hasFlags branch and missing-arg error)

**Implementation:**

**Step 1: Fix bare `--flag` handling in the hasFlags branch.**

The current code at line 80-81:
```typescript
if (arg.startsWith("--") && i + 1 < argv.length) {
	args[arg.slice(2)] = argv[++i];
}
```

This silently drops `--flag` when it's the last token or when the next token is also a `--flag`. Replace the **entire for-loop body** (lines 78-90, not just the `--` prefix branch) with the following. The replacement preserves existing `key=value` and positional-fallthrough logic while adding `-h` aliasing and bare-flag resolution:

```typescript
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "-h") {
		// Short-form alias: -h → args.help = "true"
		args.help = "true";
	} else if (arg.startsWith("--")) {
		const flag = arg.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			// --flag value: consume next token as the value
			args[flag] = next;
			i++;
		} else {
			// Bare --flag (last token or followed by another --flag): boolean true
			args[flag] = "true";
		}
	} else if (/^[^\s=]+=/.test(arg)) {
		const eqIdx = arg.indexOf("=");
		args[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
	} else if (positionalCount < def.args.length) {
		// Unmatched token — assign to next positional arg slot
		args[def.args[positionalCount].name] = arg;
		positionalCount++;
	}
}
```

Key changes:
- `-h` → `args.help = "true"` (new, enables MCP handlers to detect short-form help)
- `--flag` at end of argv → `args[flag] = "true"` (was silently dropped)
- `--flag --other` → first flag gets `"true"`, second flag starts fresh (was: second consumed as value of first)

**Step 2: Add missing-arg hint.**

The current missing-arg error at line 99-103 (inside the `else if (def.args.length > 0)` positional-only branch):
```typescript
return {
	stdout: "",
	stderr: `Missing required argument: ${argDef.name}\n`,
	exitCode: 1,
};
```

Change to:
```typescript
return {
	stdout: "",
	stderr: `Missing required argument: ${argDef.name}\n(run '${def.name} --help' for usage)\n`,
	exitCode: 1,
};
```

Exit code stays 1 (AC2.2 preserved).

**Note:** This hint only covers the positional-only error path (the `else if (def.args.length > 0)` branch). The `hasFlags` branch has no required-arg validation — if a command is invoked with `--flag value` but a required positional arg is missing, no error is produced. This is a pre-existing limitation and out of scope for this design; AC2.1 specifically scopes to "invoking `schedule` with no arguments" which hits the positional-only branch.

**Verification:**

Run: `bun run typecheck`
Expected: Passes.

**Commit:** Do not commit yet — Task 3 adds tests.
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Tests for --help interception, bare flags, and missing-arg hint

**Verifies:** command-discovery-redesign.AC1.1, command-discovery-redesign.AC1.3, command-discovery-redesign.AC1.4, command-discovery-redesign.AC1.5, command-discovery-redesign.AC1.6, command-discovery-redesign.AC2.1, command-discovery-redesign.AC2.2

**Files:**
- Modify: `packages/sandbox/src/__tests__/commands.test.ts` (add new describe block)

**Testing:**

Add a new `describe("--help and missing-arg hint")` block to the existing test file. The test file already imports `createDefineCommands`, `CommandDefinition`, mock logger/eventBus, and uses `createDatabase(":memory:")`.

Tests must verify each AC:

- **command-discovery-redesign.AC1.1:** Create a command definition with `name: "schedule"`, `description: "Schedule a deferred task"`, and `args: [{ name: "task", required: true }]`. Invoke with `["--help"]`. Assert `exitCode === 0`, `stdout` contains `"schedule"`, `stdout` contains the description, `stdout` contains `"task"`.

- **command-discovery-redesign.AC1.3:** Same command, invoke with `["-h"]`. Assert output matches `--help` output exactly.

- **command-discovery-redesign.AC1.4:** Create a command with `customHelp: true` that reads `args.help` in its handler and returns a custom response when `args.help === "true"`. Invoke with `["--help"]`. Assert the handler's custom response is returned (not `formatHelp` output). Also test with `["-h"]` — handler should see `args.help === "true"`.

- **command-discovery-redesign.AC1.5:** Same non-customHelp command from AC1.1, invoke with `["--help", "extra-arg"]`. Assert it does NOT return formatHelp output (should proceed to normal parsing — `--help` consumed as flag with `"extra-arg"` as its value, so `args.help === "extra-arg"`).

- **command-discovery-redesign.AC1.6:** Create a command with `args: [{ name: "verbose", required: false }]`. Invoke with `["--verbose"]` (bare flag, no value). Assert handler receives `args.verbose === "true"`. Also test `["--flag1", "--flag2"]` — assert both are `"true"`.

- **command-discovery-redesign.AC2.1:** Create a command with `args: [{ name: "task", required: true }]`. Invoke with `[]` (no arguments). Assert `exitCode === 1`, `stderr` contains `"Missing required argument: task"`, `stderr` contains `"(run 'schedule --help' for usage)"`.

- **command-discovery-redesign.AC2.2:** Same invocation as AC2.1. Assert `exitCode === 1`.

**Verification:**

Run: `bun test packages/sandbox/src/__tests__/commands.test.ts`
Expected: All new tests pass alongside existing tests.

**Commit:** `feat(sandbox): add --help interception, bare flag parsing, and missing-arg hint`
<!-- END_TASK_3 -->
<!-- END_SUBCOMPONENT_A -->
