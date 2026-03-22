#!/usr/bin/env bun
// Main entry for `bound` command
// Handles: bound init, bound start

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
	// Placeholder: will be implemented in Task 2
	console.error("bound init not yet implemented");
	process.exit(1);
}

if (command === "start") {
	// Placeholder: will be implemented in Task 3
	console.error("bound start not yet implemented");
	process.exit(1);
}

console.error(`Unknown command: ${command}`);
console.error('Run "bound --help" for usage information');
process.exit(1);
