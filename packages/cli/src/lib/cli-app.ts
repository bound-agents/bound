// Shared Stricli plumbing for the `bound` and `boundctl` entry points: the
// injectable CliIO sinks, the command context that carries them, flag
// shorthands, and `runCliApp`, which runs a Stricli application in-process and
// maps its outcome to a process exit code without ever calling process.exit.

import { AsyncLocalStorage } from "node:async_hooks";
import {
	AliasNotFoundError,
	type Application,
	type Command,
	type CommandContext,
	type PartialApplicationConfiguration,
	type RouteMap,
	type StricliProcess,
	run,
	text_en,
} from "@stricli/core";

/**
 * Output sinks, injectable for in-process tests. Production wires these to the
 * real `console` via {@link defaultCliIO}. A test passes capturing writers and
 * runs `main` with no spawned child, so Bun's coverage instrumentation actually
 * sees the parsing and dispatch.
 */
export interface CliIO {
	log: (message: string) => void;
	error: (message: string) => void;
}

/** Production IO: the real console. */
export function defaultCliIO(): CliIO {
	return {
		log: (m) => console.log(m),
		error: (m) => console.error(m),
	};
}

/**
 * Context handed to every command function. `process` is the Stricli-facing
 * stream/exit-code surface (routed into {@link CliIO}); commands write their
 * own diagnostics through `io` and report their exit code via {@link exitWith}.
 */
export interface CliContext extends CommandContext {
	readonly process: StricliProcess;
	readonly io: CliIO;
}

/** Records a command's exit code on the run context. */
export function exitWith(ctx: CliContext, code: number): void {
	ctx.process.exitCode = code;
}

/** Message text for errors thrown by command implementations. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Presence flag: `--name` sets true, absence is false. No `--no-name` form. */
export function booleanFlag(brief: string) {
	return { kind: "boolean", brief, default: false, withNegated: false } as const;
}

/** Optional presence flag: `--name` sets true, absence is undefined. */
export function optionalBooleanFlag(brief: string) {
	return { kind: "boolean", brief, optional: true, withNegated: false } as const;
}

/** Optional string-valued flag. */
export function stringFlag(brief: string, placeholder?: string) {
	return { kind: "parsed", parse: String, brief, optional: true, placeholder } as const;
}

/** String-valued flag with a default. */
export function defaultedStringFlag(brief: string, defaultValue: string, placeholder?: string) {
	return { kind: "parsed", parse: String, brief, default: defaultValue, placeholder } as const;
}

/** A single optional positional; the command reports its own "is required" error. */
export function optionalPositional(placeholder: string, brief: string) {
	return {
		kind: "tuple",
		parameters: [{ brief, parse: String, optional: true, placeholder }],
	} as const;
}

/** Any number of string positionals. */
export function restPositionals(placeholder: string, brief: string) {
	return { kind: "array", parameter: { brief, parse: String, placeholder } } as const;
}

/**
 * Stricli writes whole messages with a trailing newline; CliIO sinks are
 * line-oriented (`console.log` adds its own), so strip exactly one.
 */
function lineSink(emit: (message: string) => void): { write: (s: string) => void } {
	return { write: (s) => emit(s.endsWith("\n") ? s.slice(0, -1) : s) };
}

/**
 * Stricli exit codes for its own failures are negative (unknown command,
 * invalid argument, …). Every failure maps to 1 so the binaries keep their
 * 0/1 contract; a command's own positive code passes through.
 */
function toExitCode(raw: number | string | null | undefined): number {
	if (raw === undefined || raw === null || raw === 0) return 0;
	const n = typeof raw === "number" ? raw : Number(raw);
	return Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * The in-flight {@link runCliApp} call, read by the dash-value hint: its argv
 * and the long names (`--name`) of the resolved command's value-taking flags.
 */
interface ActiveRun {
	readonly args: readonly string[];
	readonly valueFlags: ReadonlySet<string>;
}

const activeRun = new AsyncLocalStorage<ActiveRun>();

type RoutingTarget = Command<CliContext> | RouteMap<CliContext>;

function isRouteMap(target: RoutingTarget): target is RouteMap<CliContext> {
	return "getRoutingTargetForInput" in target;
}

/** Walks the route maps along argv's leading positionals to the command that will run. */
function resolveCommand(
	app: Application<CliContext>,
	args: readonly string[],
): Command<CliContext> | undefined {
	let target: RoutingTarget = app.root;
	for (const arg of args) {
		if (!isRouteMap(target) || arg.startsWith("-")) break;
		const next = target.getRoutingTargetForInput(arg);
		if (next === undefined) break;
		target = next;
	}
	return isRouteMap(target) ? target.getDefaultCommand() : target;
}

/**
 * `--name` spellings of the command's flags that consume a value (`parsed` and
 * `enum`). Both the camelCase key and its kebab form are listed, since the
 * apps scan with `allow-kebab-for-camel`.
 */
function valueFlagNames(command: Command<CliContext> | undefined): Set<string> {
	const names = new Set<string>();
	const flags: Record<string, { kind: string }> = command?.parameters.flags ?? {};
	for (const [name, flag] of Object.entries(flags)) {
		if (flag.kind !== "parsed" && flag.kind !== "enum") continue;
		names.add(`--${name}`);
		names.add(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
	}
	return names;
}

/**
 * Hint appended to Stricli's `No alias registered for -x` error. The scanner
 * reads any `-letters` token as an alias batch, even in a flag's value
 * position, and has no option to force a value there; only the attached
 * `--flag=value` form carries a dash-leading value. The hint names the long
 * flag that precedes the rejected token when that flag takes a value, and
 * `--flag=-value` otherwise.
 */
function dashValueHint(alias: string, run: ActiveRun | undefined): string {
	let attached = "--flag=-value";
	const args = run?.args ?? [];
	const index = args.findIndex((arg) => /^-[a-z]+$/i.test(arg) && arg.includes(alias));
	const previous = index > 0 ? args[index - 1] : undefined;
	if (previous !== undefined && run?.valueFlags.has(previous)) {
		attached = `${previous}=${args[index]}`;
	}
	return `To pass a flag value that starts with "-", attach it with "=": ${attached}`;
}

/**
 * Localization for the `bound`/`boundctl` apps: names the binary in the
 * unknown-command error and points an unknown-alias error at the
 * `--flag=-value` form.
 */
export function cliText(binary: string): PartialApplicationConfiguration["localization"] {
	return {
		loadText: () => ({
			...text_en,
			noCommandRegisteredForInput: ({ input }: { input: string }) =>
				`Unknown command: ${input}\nRun "${binary} --help" for usage information`,
			exceptionWhileParsingArguments: (exc: unknown, ansiColor: boolean) => {
				const base = text_en.exceptionWhileParsingArguments(exc, ansiColor);
				if (!(exc instanceof AliasNotFoundError)) return base;
				return `${base}\n${dashValueHint(exc.input, activeRun.getStore())}`;
			},
		}),
	};
}

/**
 * Runs `app` against `args` in-process. Stricli's own output (per-command
 * `--help`, parse errors) is routed through `io`; ANSI colour and Stricli's
 * version check are disabled. Returns the exit code.
 */
export async function runCliApp(
	app: Application<CliContext>,
	args: readonly string[],
	io: CliIO,
): Promise<number> {
	const proc: StricliProcess = {
		stdout: lineSink(io.log),
		stderr: lineSink(io.error),
		env: { STRICLI_NO_COLOR: "1", STRICLI_SKIP_VERSION_CHECK: "1" },
		exitCode: undefined,
	};
	const valueFlags = valueFlagNames(resolveCommand(app, args));
	await activeRun.run({ args, valueFlags }, () => run(app, args, { process: proc, io }));
	return toExitCode(proc.exitCode);
}
