#!/usr/bin/env bun
// Real entry point for the `bound` command, loaded by the bound.ts shim
// AFTER reflect-metadata has been evaluated. See bound.ts for why this
// split exists.
//
// `runStart` and `createLogger` are imported LAZILY below. `bound init` must
// not evaluate any module that calls `createLogger()` at module scope: doing
// so materializes the pino root (which opens a sonic-boom async file stream
// for logs/bound.log). When `bound init` then calls `process.exit(0)`, the
// stream has not yet been "ready" and pino throws "sonic boom is not ready
// yet" on shutdown. Dynamic import keeps init entirely logger-free.

import { runInit } from "./commands/init.js";

/**
 * Output sinks + environment, injectable for in-process tests. Production wires
 * these to the real `console` and `process.env` via {@link defaultCliIO}. A
 * test passes capturing writers and runs {@link main} with no spawned child, so
 * Bun's coverage instrumentation actually sees the parsing and dispatch.
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
 * Real `bound` entry point. Parses argv (WITHOUT the leading `node`/`bun` +
 * script path — pass `process.argv.slice(2)`), dispatches to the matching
 * command, and RETURNS an exit code instead of calling `process.exit` inside
 * the tested path. The thin {@link bound.ts} launcher maps the return to
 * `process.exit`. Behavior (output text, exit codes) is identical to the prior
 * inline implementation.
 */
export async function main(args: string[], io: CliIO = defaultCliIO()): Promise<number> {
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		io.log(`
bound - Bound agent system CLI

USAGE:
  bound <command> [options]

COMMANDS:
  init        Initialize config files (bound init --ollama)
  start       Start the Bound orchestrator
  --help      Show this help message

OPTIONS:
  bound init --ollama              Initialize with Ollama preset
  bound init --bedrock --region <region>  Initialize with AWS Bedrock
  bound init --cerebras            Initialize with Cerebras Cloud preset
  bound init --zai                 Initialize with z.AI (GLM) preset
  bound init --opencode-go         Initialize with OpenCode Go preset
  bound init --umans               Initialize with umans.ai preset (self-configuring; needs UMANS_API_KEY)
  bound init --hub                 Initialize as relay hub (no local inference; proxies to spokes)
  bound init --name <name>         Set operator name
  bound init --with-sync           Also create sync.json template
  bound init --with-mcp            Also create mcp.json template
  bound init --force               Overwrite existing config

  bound login --chatgpt            Sign in with ChatGPT (OAuth) for the chatgpt-oauth provider
  bound login --challenge <id>     Resolve a raised MCP OAuth challenge (needs a running local daemon)
  bound login --mcp <server>       Warm up an MCP server: raise-and-resolve its OAuth challenge now

  bound start                       Start the orchestrator
  bound start --reseed              Wipe local DB, request full hub snapshot, then catch up via changelog

EXAMPLES:
  bound init --ollama
  bound start
  bound init --ollama --with-sync --with-mcp
  bound init --opencode-go
  bound init --hub --name hub-node  # Initialize relay hub
`);
		return 0;
	}

	if (command === "init") {
		// Parse init args
		const configDirIdx = args.indexOf("--config-dir");
		const regionIdx = args.indexOf("--region");
		const nameIdx = args.indexOf("--name");
		const initArgs = {
			hub: args.includes("--hub"),
			ollama: args.includes("--ollama"),
			bedrock: args.includes("--bedrock"),
			cerebras: args.includes("--cerebras"),
			zai: args.includes("--zai"),
			opencodeGo: args.includes("--opencode-go"),
			umans: args.includes("--umans"),
			region: regionIdx !== -1 ? args[regionIdx + 1] : undefined,
			name: nameIdx !== -1 ? args[nameIdx + 1] : undefined,
			withSync: args.includes("--with-sync"),
			withMcp: args.includes("--with-mcp"),
			force: args.includes("--force"),
			configDir: configDirIdx !== -1 ? args[configDirIdx + 1] : "config",
		};

		try {
			await runInit(initArgs);
		} catch (error) {
			io.error(`Init failed: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
		return 0;
	}

	if (command === "login") {
		const loginConfigIdx = args.indexOf("--config-dir");
		const challengeIdx = args.indexOf("--challenge");
		const mcpIdx = args.indexOf("--mcp");
		const urlIdx = args.indexOf("--url");
		const { runLogin } = await import("./commands/login.js");
		try {
			await runLogin({
				chatgpt: args.includes("--chatgpt"),
				challenge: challengeIdx !== -1 ? args[challengeIdx + 1] : undefined,
				mcp: mcpIdx !== -1 ? args[mcpIdx + 1] : undefined,
				configDir: loginConfigIdx !== -1 ? args[loginConfigIdx + 1] : "config",
				daemonUrl: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
			});
		} catch (error) {
			io.error(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
		return 0;
	}

	if (command === "start") {
		// Parse start args
		const startConfigIdx = args.indexOf("--config-dir");
		const startArgs = {
			configDir: startConfigIdx !== -1 ? args[startConfigIdx + 1] : "config",
			reseed: args.includes("--reseed"),
		};

		// Lazy import: keeps `bound init` off the start-subtree load path, which
		// avoids materializing the pino logger (sonic-boom) before we need it.
		const [{ runStart }, { createLogger }] = await Promise.all([
			import("./commands/start/index.js"),
			import("@bound/shared"),
		]);

		try {
			await runStart(startArgs);
			return 0;
		} catch (error) {
			// createLogger is idempotent; bootstrap may or may not have already
			// materialized the pino root, either way we reuse it here.
			createLogger("@bound/cli", "bound").error("Start failed", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			return 1;
		}
	}

	io.error(`Unknown command: ${command}`);
	io.error('Run "bound --help" for usage information');
	return 1;
}
