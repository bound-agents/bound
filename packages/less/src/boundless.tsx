#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { hostname as getHostname } from "node:os";
import { join } from "node:path";
import { BoundClient } from "@bound/client";
import {
	type Thread,
	getBuildInfo,
	initTelemetry,
	loadBuildInfo,
	prewarmHighlighter,
	shutdownTelemetry,
} from "@bound/shared";
import {
	ArgumentScannerError,
	type CommandContext,
	type StricliProcess,
	buildApplication,
	buildCommand,
	formatMessageForArgumentScannerError,
	run,
	text_en,
} from "@stricli/core";
import { render } from "ink";
// biome-ignore lint/correctness/noUnusedImports: React is used implicitly in JSX
import React from "react";
import { runAcpServer } from "./acp/server";
import { rememberLocalSession } from "./acp/session-registry";
import { loadConfig, loadMcpConfig } from "./config";
import { acquireLock, releaseLock } from "./lockfile";
import { AppLogger } from "./logging";
import { McpServerManager } from "./mcp/manager";
import { performAttach } from "./session/attach";
import { configureLessTelemetryFromOpenTelemetry } from "./telemetry";
import { buildToolSet } from "./tools/registry";
import { SandboxOverrideStore } from "./tools/sandbox-override";
import { resolveSandboxConfig } from "./tools/sandbox-policy";
import { type ResolvedShell, resolveShell } from "./tools/shell";
import { App } from "./tui/App";
import { TerminalTitleController, formatThreadTitleForTerminal } from "./tui/util/terminal-title";

export async function shutdownBeforeFatalExit(
	shutdown: () => Promise<void> = shutdownTelemetry,
	exit: (code: number) => void = process.exit,
): Promise<void> {
	try {
		await shutdown();
	} catch {
		// Fatal shutdown must still terminate when the exporter itself fails.
	}
	exit(1);
}

export interface ParsedArgs {
	attachArg: string | null;
	urlArg: string | null;
	/** Run as an ACP agent server over stdio instead of rendering the TUI. */
	acp: boolean;
}

const parseArgsCommand = buildCommand({
	docs: { brief: "Terminal coding agent for a Bound server" },
	parameters: {
		flags: {
			attach: {
				kind: "parsed",
				parse: String,
				brief: "Resume an existing thread",
				optional: true,
				placeholder: "thread-id",
			},
			url: {
				kind: "parsed",
				parse: String,
				brief: "Bound server URL (default from config)",
				optional: true,
				placeholder: "url",
			},
			acp: {
				kind: "boolean",
				brief: "Run as an ACP agent server over stdio",
				default: false,
				withNegated: false,
			},
		},
		positional: { kind: "array", parameter: { brief: "Ignored", parse: String } },
	},
	func(
		this: ParseArgsContext,
		flags: { attach?: string; url?: string; acp: boolean },
		..._ignored: string[]
	): void {
		this.parsed = { attachArg: flags.attach ?? null, urlArg: flags.url ?? null, acp: flags.acp };
	},
});

interface ParseArgsContext extends CommandContext {
	readonly process: StricliProcess;
	parsed: ParsedArgs | null;
}

const parseArgsApp = buildApplication<ParseArgsContext>(parseArgsCommand, {
	name: "boundless",
	scanner: { caseStyle: "allow-kebab-for-camel" },
	localization: {
		loadText: () => ({
			...text_en,
			exceptionWhileParsingArguments: (exc: unknown) =>
				exc instanceof ArgumentScannerError
					? formatMessageForArgumentScannerError(exc, {
							FlagNotFoundError: (e) => `Unknown flag: --${e.input}`,
							UnsatisfiedFlagError: (e) => `Flag --${e.externalFlagName} requires a value`,
						})
					: String(exc),
		}),
	},
});

/**
 * Parses boundless argv with Stricli. Resolves to the parsed flags, or to
 * `null` when the input was `--help` (the help text has already been written
 * to `stdout`). Rejects with the scanner diagnostic on bad input.
 */
export async function parseArgs(
	args: string[],
	stdout: (text: string) => void = (text) => process.stdout.write(text),
): Promise<ParsedArgs | null> {
	const errors: string[] = [];
	const context: ParseArgsContext = {
		process: {
			stdout: { write: stdout },
			stderr: { write: (text) => errors.push(text.replace(/\n$/, "")) },
			env: { STRICLI_NO_COLOR: "1", STRICLI_SKIP_VERSION_CHECK: "1" },
			exitCode: undefined,
		},
		parsed: null,
	};
	await run(parseArgsApp, args, context);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	return context.parsed;
}

export async function resolveThread(
	client: BoundClient,
	attachArg: string | null,
): Promise<Thread> {
	if (attachArg) {
		return await client.getThread(attachArg);
	}
	// Tag new threads as `boundless` so the remote bound daemon can inject
	// the right platform context into the agent's volatile state.
	return await client.createThread({ interface: "boundless" });
}

export async function resolveThreadId(
	client: BoundClient,
	attachArg: string | null,
): Promise<string> {
	const thread = await resolveThread(client, attachArg);
	return thread.id;
}

/**
 * Runs boundless as an ACP agent server over stdio. Loads config, resolves the
 * shell, initializes the file logger, then hands control to {@link runAcpServer}
 * which owns the stdio JSON-RPC channel until the connection closes.
 *
 * stdout is reserved for ACP frames in this mode — diagnostics go to stderr
 * (fatal startup errors) or the file logger. `--attach` is accepted but ignored
 * here: ACP clients open sessions via session/new and session/load.
 */
async function runAcpMode(args: {
	attachArg: string | null;
	urlArg: string | null;
}): Promise<void> {
	// Settle build info so initialize() can report the running commit. This does
	// not write to stdout, so it is safe in ACP mode.
	await loadBuildInfo();

	const configDir = join(homedir(), ".bound", "less");
	mkdirSync(configDir, { recursive: true });
	const [config, mcpConfig] = await Promise.all([loadConfig(configDir), loadMcpConfig(configDir)]);
	if (args.urlArg) {
		config.url = args.urlArg;
	}

	let shell: ResolvedShell;
	try {
		shell = resolveShell(config.shell);
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(1);
	}

	const logger = new AppLogger(configDir);
	const hostname = getHostname();

	try {
		await runAcpServer({
			url: config.url,
			configDir,
			mcpConfigs: mcpConfig.servers,
			hostname,
			shell,
			sandbox: resolveSandboxConfig(config.sandbox),
			logger,
			modelId: config.model,
			contextFiles: config.contextFiles,
		});
	} finally {
		logger.close();
		await shutdownTelemetry();
	}
}

async function main(): Promise<void> {
	const terminalTitle = new TerminalTitleController();
	try {
		// Telemetry. No-op unless OTEL_ENABLED is set. Done first so
		// every subsequent operation that creates a span (sendMessage, tool
		// execution, etc.) gets exported to the configured OTLP endpoint.
		initTelemetry("boundless");
		configureLessTelemetryFromOpenTelemetry();

		// Parse arguments. Done before any stdout-touching work because
		// in --acp mode stdout is the JSON-RPC channel and must stay pristine.
		let parsed: ParsedArgs | null;
		try {
			parsed = await parseArgs(process.argv.slice(2));
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
			process.exit(1);
		}
		if (!parsed) process.exit(0);
		const { attachArg, urlArg, acp } = parsed;

		// ACP mode: run as an ACP agent server over stdio. Branch BEFORE the
		// highlighter prewarm / build-info / TUI render — none of which may run
		// here, since anything written to stdout would corrupt the JSON-RPC
		// frames. Build metadata is still loaded (it does not write to stdout)
		// so initialize() can report the running commit as the agent version.
		if (acp) {
			await runAcpMode({ attachArg, urlArg });
			return;
		}

		// Kick off shiki highlighter init in the background. Loading the
		// Oniguruma WASM and tokyo-night grammars takes ~hundreds of ms;
		// firing it here lets it overlap with the WebSocket connect and
		// attach I/O below. We await before render() so message history
		// rendered into Ink's <Static> always gets highlighted (Static
		// commits its items to stdout permanently and cannot reflow).
		const highlighterReady = prewarmHighlighter();

		// Load build metadata (commit hash, build time) used by the session
		// splash header. Same fire-now/await-before-render pattern: cheap to
		// kick off in parallel, must be settled before <App> mounts so the
		// SessionHeader rendered into <Static> shows the right commit hash.
		const buildInfoReady = loadBuildInfo();

		const configDir = join(homedir(), ".bound", "less");
		mkdirSync(configDir, { recursive: true });
		const [config, mcpConfig] = await Promise.all([
			loadConfig(configDir),
			loadMcpConfig(configDir),
		]);

		// Override config.url if --url provided (without persisting)
		if (urlArg) {
			config.url = urlArg;
		}

		// Resolve the shell for the bash-family tool. An invalid override is a
		// fatal error at startup — surface it cleanly rather than falling back.
		let shell: ResolvedShell;
		try {
			shell = resolveShell(config.shell);
		} catch (error) {
			process.stderr.write(`${(error as Error).message}\n`);
			process.exit(1);
		}

		// Resolve the filesystem sandbox policy (opt-out: enabled unless the
		// config disables it). Threaded into the bash tool alongside the shell.
		const sandbox = resolveSandboxConfig(config.sandbox);

		// Per-thread sandbox override store (the `/sandbox` TUI command). Session-
		// scoped, in-process, operator-only — see sandbox-override.ts. Created once
		// per boundless session and shared by the tool-call hook (read-only resolver)
		// and the ChatView `/sandbox` dispatch (mutator).
		const sandboxOverrides = new SandboxOverrideStore();

		// Connect BoundClient with timeout
		const client = new BoundClient(config.url);
		try {
			await client.connect();
		} catch (error) {
			process.stderr.write(`Error: Could not connect to bound server at ${config.url}\n`);
			process.stderr.write(`${(error as Error).message}\n`);
			process.exit(1);
		}

		let initialThread: Thread;
		try {
			initialThread = await resolveThread(client, attachArg);
		} catch {
			process.stderr.write(`Error: Thread not found: ${attachArg}\n`);
			process.exit(1);
		}
		const threadId = initialThread.id;

		try {
			acquireLock(configDir, threadId, process.cwd());
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
			process.exit(1);
		}

		// Record this thread + its local cwd in the session registry so the ACP
		// import (listSessions) can offer it later. A TUI attach establishes a
		// local working dir for the thread on this machine exactly as an ACP
		// loadSession does, so it earns a registry entry the same way.
		rememberLocalSession(configDir, threadId, process.cwd());

		const logger = new AppLogger(configDir);
		const mcpManager = new McpServerManager(logger);
		const hostname = getHostname();

		const attachResult = await performAttach({
			client,
			threadId,
			mcpManager,
			mcpConfigs: mcpConfig.servers,
			cwd: process.cwd(),
			hostname,
			logger,
			injectContextFiles: config.contextFiles,
			shell,
			sandbox,
		});

		const mcpTools = mcpManager.getRunningTools();
		const toolSet = buildToolSet({ hostname, mcpTools, boundUrl: config.url, shell, sandbox });

		// Block on the shiki highlighter before render so initial message
		// history (committed to Ink's <Static>) is fully syntax-highlighted.
		// In practice this finishes during attach, so the await is usually
		// a no-op; on a cold start it adds a few hundred ms.
		await highlighterReady;
		await buildInfoReady;
		const { commitHash } = getBuildInfo();

		// Ink requires raw-mode stdin — without a TTY it throws "Raw mode is
		// not supported", and the error path inside Ink has a race condition
		// between waitUntilExit() and unmount() that causes a silent hang.
		// Catch this early with a clear message.
		if (!process.stdin.isTTY) {
			process.stderr.write("Error: boundless requires a terminal (TTY).\n");
			process.stderr.write("  stdin is not a TTY — are you piping or redirecting input?\n");
			process.exit(1);
		}

		terminalTitle.set(formatThreadTitleForTerminal(initialThread.title));

		const { waitUntilExit } = render(
			<App
				client={client}
				threadId={threadId}
				configDir={configDir}
				cwd={process.cwd()}
				commitHash={commitHash}
				hostname={hostname}
				mcpManager={mcpManager}
				mcpConfigs={mcpConfig.servers}
				logger={logger}
				initialMessages={attachResult.messages}
				model={attachResult.lastUsedModelId ?? config.model}
				toolHandlers={toolSet.handlers}
				initialThreadTitle={initialThread.title}
				terminalTitle={terminalTitle}
				contextFiles={config.contextFiles}
				shell={shell}
				sandbox={sandbox}
				sandboxOverrides={sandboxOverrides}
			/>,
			{ exitOnCtrlC: false },
		);

		// SIGTERM handler for graceful shutdown
		process.on("SIGTERM", async () => {
			await mcpManager.terminateAll();
			releaseLock(configDir, threadId);
			client.disconnect();
			logger.close();
			await shutdownTelemetry();
			terminalTitle.restore();
			process.exit(0);
		});

		await waitUntilExit();

		// Clean up on normal exit
		await mcpManager.terminateAll();
		releaseLock(configDir, threadId);
		client.disconnect();
		logger.close();
		await shutdownTelemetry();
		terminalTitle.restore();
	} catch (error) {
		terminalTitle.restore();
		process.stderr.write(`Fatal error: ${(error as Error).message}\n`);
		await shutdownBeforeFatalExit();
	}
}

/**
 * Detect whether this module is the program entry point.
 *
 * In source mode, {@link import.meta.main} is true when the file is run
 * directly via `bun run`. In a `Bun.build({ compile: … })` binary, however,
 * `import.meta.main` is always `false` (Bun v1.3.14).  The compiled binary
 * is a single-module executable, so `Bun.main` matches `import.meta.path`
 * (after normalising slashes).  Use that as a reliable fallback.
 */
function isEntryPoint(): boolean {
	if (import.meta.main) return true;
	if (typeof Bun === "undefined") return false;
	// Bun.main always uses `/` regardless of platform, so normalise
	// import.meta.path to match.
	return Bun.main !== undefined && Bun.main === import.meta.path.replace(/\\/g, "/");
}

// Only run main() when this file is executed directly as the CLI entrypoint,
// not when imported by tests or other modules. Without this guard, importing
// anything from boundless.tsx (e.g. parseArgs in boundless-startup.test.ts)
// would trigger a full Ink render against the non-TTY test stdin and abort
// the whole test suite with "Raw mode is not supported".
if (isEntryPoint()) {
	main();
}
