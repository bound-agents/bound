#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { hostname as getHostname } from "node:os";
import { join } from "node:path";
import { BoundClient } from "@bound/client";
import { render } from "ink";
// biome-ignore lint/correctness/noUnusedImports: React is used implicitly in JSX
import React from "react";
import { loadConfig, loadMcpConfig } from "./config";
import { acquireLock, releaseLock } from "./lockfile";
import { AppLogger } from "./logging";
import { McpServerManager } from "./mcp/manager";
import { performAttach } from "./session/attach";
import { buildToolSet } from "./tools/registry";
import { App } from "./tui/App";

export interface ParsedArgs {
	attachArg: string | null;
	urlArg: string | null;
}

export function parseArgs(args: string[]): ParsedArgs {
	let attachArg: string | null = null;
	let urlArg: string | null = null;

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
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		}
	}

	return { attachArg, urlArg };
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

async function main(): Promise<void> {
	try {
		// Step 1: Parse arguments
		let attachArg: string | null = null;
		let urlArg: string | null = null;
		try {
			({ attachArg, urlArg } = parseArgs(process.argv.slice(2)));
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
			process.exit(1);
		}

		// Step 2: Load config
		const configDir = join(homedir(), ".bound", "less");
		mkdirSync(configDir, { recursive: true });
		const config = loadConfig(configDir);
		const mcpConfig = loadMcpConfig(configDir);

		// Override config.url if --url provided (without persisting)
		if (urlArg) {
			config.url = urlArg;
		}

		// Step 3: Connect BoundClient with timeout
		const client = new BoundClient(config.url);
		try {
			let timeoutHandle: NodeJS.Timeout | null = null;
			await Promise.race([
				client.connect(),
				new Promise<void>((_resolve, reject) => {
					timeoutHandle = setTimeout(() => reject(new Error("Connection timeout")), 10000);
				}),
			]).finally(() => {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
			});
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
		});

		// Step 8: Build tool set for App
		const mcpTools = mcpManager.getRunningTools();
		const toolSet = buildToolSet(process.cwd(), hostname, mcpTools, undefined);

		// Step 9: Render App
		const { waitUntilExit } = render(
			<App
				client={client}
				threadId={threadId}
				configDir={configDir}
				cwd={process.cwd()}
				hostname={hostname}
				mcpManager={mcpManager}
				mcpConfigs={mcpConfig.servers}
				logger={logger}
				initialMessages={attachResult.messages}
				model={config.model}
				toolHandlers={toolSet.handlers}
			/>,
			{ exitOnCtrlC: false },
		);

		// Step 10: SIGTERM handler for graceful shutdown
		process.on("SIGTERM", async () => {
			await mcpManager.terminateAll();
			releaseLock(configDir, threadId);
			client.disconnect();
			logger.close();
			process.exit(0);
		});

		// Step 11: Wait for exit
		await waitUntilExit();

		// Clean up on normal exit
		await mcpManager.terminateAll();
		releaseLock(configDir, threadId);
		client.disconnect();
		logger.close();
	} catch (error) {
		process.stderr.write(`Fatal error: ${(error as Error).message}\n`);
		process.exit(1);
	}
}

// Only run main() when this file is executed directly as the CLI entrypoint,
// not when imported by tests or other modules. Without this guard, importing
// anything from boundless.tsx (e.g. parseArgs in boundless-startup.test.ts)
// would trigger a full Ink render against the non-TTY test stdin and abort
// the whole test suite with "Raw mode is not supported".
if (import.meta.main) {
	main();
}
