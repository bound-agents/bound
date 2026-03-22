#!/usr/bin/env bun
// Main entry for `bound` command
// Handles: bound init, bound start

import { runInit } from "./commands/init.js";
import { runStart } from "./commands/start.js";

async function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		console.log(`
bound - Bound agent system CLI

USAGE:
  bound <command> [options]

COMMANDS:
  init        Initialize config files (bound init --ollama)
  start       Start the Bound orchestrator
  --help      Show this help message

OPTIONS:
  bound init --ollama              Initialize with Ollama preset
  bound init --anthropic           Initialize with Anthropic API preset
  bound init --bedrock --region <region>  Initialize with AWS Bedrock
  bound init --name <name>         Set operator name
  bound init --with-sync           Also create sync.json template
  bound init --with-mcp            Also create mcp.json template
  bound init --with-overlay        Also create overlay.json template
  bound init --force               Overwrite existing config

  bound start                       Start the orchestrator

EXAMPLES:
  bound init --ollama
  bound start
  bound init --anthropic --with-sync --with-mcp
`);
		process.exit(0);
	}

	if (command === "init") {
		// Parse init args
		const initArgs = {
			ollama: args.includes("--ollama"),
			anthropic: args.includes("--anthropic"),
			bedrock: args.includes("--bedrock"),
			region: args[args.indexOf("--region") + 1],
			name: args[args.indexOf("--name") + 1],
			withSync: args.includes("--with-sync"),
			withMcp: args.includes("--with-mcp"),
			withOverlay: args.includes("--with-overlay"),
			force: args.includes("--force"),
			configDir: args[args.indexOf("--config-dir") + 1] || "config",
		};

		try {
			await runInit(initArgs);
		} catch (error) {
			console.error("Init failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	if (command === "start") {
		// Parse start args
		const startArgs = {
			configDir: args[args.indexOf("--config-dir") + 1] || "config",
		};

		try {
			await runStart(startArgs);
		} catch (error) {
			console.error("Start failed:", error);
			process.exit(1);
		}
		process.exit(0);
	}

	console.error(`Unknown command: ${command}`);
	console.error('Run "bound --help" for usage information');
	process.exit(1);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
