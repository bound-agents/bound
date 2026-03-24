#!/usr/bin/env bun
// Main entry for `bound` command
// Handles: bound init, bound start
import "reflect-metadata";

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
		const configDirIdx = args.indexOf("--config-dir");
		const regionIdx = args.indexOf("--region");
		const nameIdx = args.indexOf("--name");
		const initArgs = {
			ollama: args.includes("--ollama"),
			anthropic: args.includes("--anthropic"),
			bedrock: args.includes("--bedrock"),
			region: regionIdx !== -1 ? args[regionIdx + 1] : undefined,
			name: nameIdx !== -1 ? args[nameIdx + 1] : undefined,
			withSync: args.includes("--with-sync"),
			withMcp: args.includes("--with-mcp"),
			withOverlay: args.includes("--with-overlay"),
			force: args.includes("--force"),
			configDir: configDirIdx !== -1 ? args[configDirIdx + 1] : "config",
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
		const startConfigIdx = args.indexOf("--config-dir");
		const startArgs = {
			configDir: startConfigIdx !== -1 ? args[startConfigIdx + 1] : "config",
		};

		try {
			await runStart(startArgs);
			process.exit(0);
		} catch (error) {
			console.error("Start failed:", error);
			process.exit(1);
		}
	}

	console.error(`Unknown command: ${command}`);
	console.error('Run "bound --help" for usage information');
	process.exit(1);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
