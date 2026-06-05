#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { hostname as getHostname } from "node:os";
import { join } from "node:path";
import { BoundClient } from "@bound/client";
import {
	getBuildInfo,
	initTelemetry,
	loadBuildInfo,
	prewarmHighlighter,
	shutdownTelemetry,
} from "@bound/shared";
import { render } from "ink";
// biome-ignore lint/correctness/noUnusedImports: React is used implicitly in JSX
import React from "react";
import { runAcpServer } from "./acp/server";
import { loadConfig, loadMcpConfig } from "./config";
import { acquireLock, releaseLock } from "./lockfile";
import { AppLogger } from "./logging";
import { McpServerManager } from "./mcp/manager";
import { performAttach } from "./session/attach";
import { buildToolSet } from "./tools/registry";
import { type ResolvedShell, resolveShell } from "./tools/shell";
import { App } from "./tui/App";

export interface ParsedArgs {
	attachArg: string | null;
	urlArg: string | null;
	/** Run as an ACP agent server over stdio instead of rendering the TUI. */
	acp: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
	let attachArg: string | null = null;
	let urlArg: string | null = null;
	let acp = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--attach") {
			if (i + 1 >= args.length) {
				throw new Error("Flag --attach requires a value");
			}
			attachArg = args[++i];
		} else if (arg === "--url") {
			if (i + 1 >= args.length) {
				throw new Error("Flag --url requires a value");
			}
			urlArg = args[++i];
		} else if (arg === "--acp") {
			acp = true;
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		}
	}

	return { attachArg, urlArg, acp };
}

export async function resolveThreadId(
	client: BoundClient,
	attachArg: string | null,
): Promise<string> {
	if (attachArg) {
		const thread = await client.getThread(attachArg);
		return thread.id;
	}
	// Tag new threads as `boundless` so the remote bound daemon can inject
	// the right platform context into the agent's volatile state.
	const thread = await client.createThread({ interface: "boundless" });
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
	const config = loadConfig(configDir);
	const mcpConfig = loadMcpConfig(configDir);
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
	try {
		// Step 0: Telemetry. No-op unless OTEL_ENABLED is set. Done first so
		// every subsequent operation that creates a span (sendMessage, tool
		// execution, etc.) gets exported to the configured OTLP endpoint.
		initTelemetry("boundless");

		// Step 1: Parse arguments. Done before any stdout-touching work because
		// in --acp mode stdout is the JSON-RPC channel and must stay pristine.
		let attachArg: string | null = null;
		let urlArg: string | null = null;
		let acp = false;
		try {
			({ attachArg, urlArg, acp } = parseArgs(process.argv.slice(2)));
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
			process.exit(1);
		}

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

		// Step 2: Load config
		const configDir = join(homedir(), ".bound", "less");
		mkdirSync(configDir, { recursive: true });
		const config = loadConfig(configDir);
		const mcpConfig = loadMcpConfig(configDir);

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

		// Step 3: Connect BoundClient with timeout
		const client = new BoundClient(config.url);
		try {
			await client.connect();
		} catch (error) {
			process.stderr.write(`Error: Could not connect to bound server at ${config.url}\n`);
			process.stderr.write(`${(error as Error).message}\n`);
			process.exit(1);
		}

		// Step 4: Get or create thread
		let threadId: string;
		try {
			threadId = await resolveThreadId(client, attachArg);
		} catch {
			process.stderr.write(`Error: Thread not found: ${attachArg}\n`);
			process.exit(1);
		}

		// Step 5: Acquire lockfile
		try {
			acquireLock(configDir, threadId, process.cwd());
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
			process.exit(1);
		}

		// Step 6: Initialize logger and MCP
		const logger = new AppLogger(configDir);
		const mcpManager = new McpServerManager(logger);
		const hostname = getHostname();

		// Step 7: Perform attach
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
		});

		// Step 8: Build tool set for App
		const mcpTools = mcpManager.getRunningTools();
		const toolSet = buildToolSet(process.cwd(), hostname, mcpTools, undefined, config.url, shell);

		// Block on the shiki highlighter before render so initial message
		// history (committed to Ink's <Static>) is fully syntax-highlighted.
		// In practice this finishes during attach, so the await is usually
		// a no-op; on a cold start it adds a few hundred ms.
		await highlighterReady;
		await buildInfoReady;
		const { commitHash } = getBuildInfo();

		// Step 9: Render App
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
				model={config.model}
				toolHandlers={toolSet.handlers}
				shell={shell}
			/>,
			{ exitOnCtrlC: false },
		);

		// Step 10: SIGTERM handler for graceful shutdown
		process.on("SIGTERM", async () => {
			await mcpManager.terminateAll();
			releaseLock(configDir, threadId);
			client.disconnect();
			logger.close();
			await shutdownTelemetry();
			process.exit(0);
		});

		// Step 11: Wait for exit
		await waitUntilExit();

		// Clean up on normal exit
		await mcpManager.terminateAll();
		releaseLock(configDir, threadId);
		client.disconnect();
		logger.close();
		await shutdownTelemetry();
	} catch (error) {
		process.stderr.write(`Fatal error: ${(error as Error).message}\n`);
		process.exit(1);
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
