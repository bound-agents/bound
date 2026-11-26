#!/usr/bin/env bun
// Implementation of the `bound` command; bound.ts is the binary entry point.
//
// `runStart` and `createLogger` are imported LAZILY below. `bound init` must
// not evaluate any module that calls `createLogger()` at module scope: doing
// so materializes the pino root (which opens a sonic-boom async file stream
// for logs/bound.log). When `bound init` then calls `process.exit(0)`, the
// stream has not yet been "ready" and pino throws "sonic boom is not ready
// yet" on shutdown. Dynamic import keeps init entirely logger-free.

import { buildApplication, buildCommand, buildRouteMap } from "@stricli/core";
import { type InitArgs, runInit } from "./commands/init.js";
import type { LoginArgs } from "./commands/login.js";
import {
	type CliContext,
	type CliIO,
	booleanFlag,
	defaultCliIO,
	defaultedStringFlag,
	errorMessage,
	exitWith,
	runCliApp,
	stringFlag,
	unknownCommandText,
} from "./lib/cli-app.js";

export { type CliIO, defaultCliIO } from "./lib/cli-app.js";

const ROOT_HELP = `
bound - Bound agent system CLI

USAGE:
  bound <command> [options]
  bound <command> --help           Show the flags for one command

COMMANDS:
  init        Initialize config files (bound init --ollama)
  login       Sign in to a provider or resolve an MCP OAuth challenge
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
  bound login --copilot            Sign in with GitHub (device flow) for the github-copilot provider
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
`;

const configDirFlag = defaultedStringFlag("Config directory", "config", "dir");

/** `bound init` flags: every preset/switch is a presence flag, values stay optional. */
type InitFlags = Required<Omit<InitArgs, "anthropic" | "region" | "name">> &
	Pick<InitArgs, "region" | "name">;

const initCommand = buildCommand({
	docs: { brief: "Initialize config files" },
	parameters: {
		flags: {
			hub: booleanFlag("Initialize as relay hub (no local inference; proxies to spokes)"),
			ollama: booleanFlag("Initialize with Ollama preset"),
			bedrock: booleanFlag("Initialize with AWS Bedrock (use with --region)"),
			cerebras: booleanFlag("Initialize with Cerebras Cloud preset"),
			zai: booleanFlag("Initialize with z.AI (GLM) preset"),
			opencodeGo: booleanFlag("Initialize with OpenCode Go preset"),
			umans: booleanFlag("Initialize with umans.ai preset (needs UMANS_API_KEY)"),
			region: stringFlag("AWS region for --bedrock", "region"),
			name: stringFlag("Operator name", "name"),
			withSync: booleanFlag("Also create sync.json template"),
			withMcp: booleanFlag("Also create mcp.json template"),
			force: booleanFlag("Overwrite existing config"),
			configDir: configDirFlag,
		},
	},
	async func(this: CliContext, flags: InitFlags) {
		try {
			await runInit(flags);
			exitWith(this, 0);
		} catch (error) {
			this.io.error(`Init failed: ${errorMessage(error)}`);
			exitWith(this, 1);
		}
	},
});

interface LoginFlags {
	readonly chatgpt: boolean;
	readonly copilot: boolean;
	readonly challenge?: string;
	readonly mcp?: string;
	readonly configDir: string;
	readonly url?: string;
}

/** Maps parsed `bound login` flags onto {@link LoginArgs}. */
function toLoginArgs(flags: LoginFlags): LoginArgs {
	return {
		chatgpt: flags.chatgpt,
		copilot: flags.copilot,
		challenge: flags.challenge,
		mcp: flags.mcp,
		configDir: flags.configDir,
		daemonUrl: flags.url,
	};
}

/** `bound login`, with the action injectable so the flag mapping is testable. */
function buildLoginCommand(action: (ctx: CliContext, args: LoginArgs) => Promise<number>) {
	return buildCommand({
		docs: { brief: "Sign in to a provider or resolve an MCP OAuth challenge" },
		parameters: {
			flags: {
				chatgpt: booleanFlag("Sign in with ChatGPT (OAuth) for the chatgpt-oauth provider"),
				copilot: booleanFlag("Sign in with GitHub (device flow) for the github-copilot provider"),
				challenge: stringFlag(
					"Resolve a raised MCP OAuth challenge (needs a running daemon)",
					"id",
				),
				mcp: stringFlag(
					"Warm up an MCP server: raise-and-resolve its OAuth challenge now",
					"server",
				),
				configDir: configDirFlag,
				url: stringFlag("Local daemon URL", "url"),
			},
		},
		async func(this: CliContext, flags: LoginFlags) {
			exitWith(this, await action(this, toLoginArgs(flags)));
		},
	});
}

const loginCommand = buildLoginCommand(async (ctx, loginArgs) => {
	const { runLogin } = await import("./commands/login.js");
	try {
		await runLogin(loginArgs);
		return 0;
	} catch (error) {
		ctx.io.error(`Login failed: ${errorMessage(error)}`);
		return 1;
	}
});

const startCommand = buildCommand({
	docs: { brief: "Start the Bound orchestrator" },
	parameters: {
		flags: {
			configDir: configDirFlag,
			reseed: booleanFlag("Wipe local DB, request full hub snapshot, then catch up via changelog"),
		},
	},
	async func(this: CliContext, flags: { configDir: string; reseed: boolean }) {
		// Lazy import: keeps `bound init` off the start-subtree load path, which
		// avoids materializing the pino logger (sonic-boom) before we need it.
		const [{ runStart }, { createLogger }] = await Promise.all([
			import("./commands/start/index.js"),
			import("@bound/shared"),
		]);

		try {
			await runStart(flags);
			exitWith(this, 0);
		} catch (error) {
			// createLogger is idempotent; bootstrap may or may not have already
			// materialized the pino root, either way we reuse it here.
			createLogger("@bound/cli", "bound").error("Start failed", {
				error: errorMessage(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			exitWith(this, 1);
		}
	},
});

const APP_CONFIG = {
	name: "bound",
	scanner: { caseStyle: "allow-kebab-for-camel" },
	documentation: { caseStyle: "convert-camel-to-kebab" },
	localization: unknownCommandText("bound"),
} as const;

const app = buildApplication<CliContext>(
	buildRouteMap({
		routes: { init: initCommand, login: loginCommand, start: startCommand },
		docs: { brief: "Bound agent system CLI" },
	}),
	APP_CONFIG,
);

/**
 * Parses `bound login ...` argv (command word included) with the real login
 * command definition and returns the mapped {@link LoginArgs} without running
 * the login. Throws with Stricli's diagnostic when the flags do not parse.
 */
export async function parseLoginArgs(args: string[]): Promise<LoginArgs> {
	let parsed: LoginArgs | undefined;
	const errors: string[] = [];
	const probe = buildApplication<CliContext>(
		buildRouteMap({
			routes: {
				login: buildLoginCommand(async (_ctx, loginArgs) => {
					parsed = loginArgs;
					return 0;
				}),
			},
			docs: { brief: "bound login parser" },
		}),
		APP_CONFIG,
	);
	await runCliApp(probe, args, { log: () => {}, error: (m) => errors.push(m) });
	if (!parsed) throw new Error(errors.join("\n") || "login arguments did not parse");
	return parsed;
}

/**
 * Real `bound` entry point. Parses argv (WITHOUT the leading `node`/`bun` +
 * script path — pass `process.argv.slice(2)`), dispatches to the matching
 * command, and RETURNS an exit code instead of calling `process.exit` inside
 * the tested path. The thin {@link bound.ts} launcher maps the return to
 * `process.exit`. The bare / `--help` / `-h` overview is the curated text
 * above; `bound <command> --help` is generated from the command definition.
 */
export async function main(args: string[], io: CliIO = defaultCliIO()): Promise<number> {
	const command = args[0];
	if (!command || command === "--help" || command === "-h") {
		io.log(ROOT_HELP);
		return 0;
	}
	return runCliApp(app, args, io);
}
