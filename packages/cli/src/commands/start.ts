// Task 3: bound start command
// Full orchestrator bootstrap sequence

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createAppContext } from "@bound/core";

export interface StartArgs {
	configDir?: string;
}

export async function runStart(args: StartArgs): Promise<void> {
	const configDir = args.configDir || "config";

	console.log("Starting Bound orchestrator...");

	// Bootstrap sequence per spec:
	// 1. Load and validate all config files
	console.log("Loading configuration...");
	mkdirSync("data", { recursive: true });
	const dbPath = resolve("data", "bound.db");

	let appContext: Awaited<ReturnType<typeof createAppContext>>;
	try {
		appContext = createAppContext(resolve(configDir), dbPath);
	} catch (error) {
		console.error(
			"Configuration error:",
			error instanceof Error ? error.message : String(error),
		);
		process.exit(1);
	}

	// 2. Ensure Ed25519 keypair via @bound/sync
	console.log("Initializing cryptography...");
	// TODO: ensureKeypair() from @bound/sync

	// 3. Create/open SQLite database and run migrations
	console.log("Initializing database...");
	// TODO: Database setup and schema migrations

	// 4. Create DI container
	console.log("Setting up services...");
	// TODO: Bootstrap tsyringe container

	// 5. User seeding
	console.log("Seeding users from allowlist...");
	// TODO: Seed users with deterministic UUIDs

	// 6. Host registration
	console.log("Registering host...");
	// TODO: Upsert host entry in hosts table

	// 7. Crash recovery scan
	console.log("Scanning for crash recovery...");
	// TODO: Scan for interrupted loops and insert recovery messages

	// 8. MCP connections
	console.log("Initializing MCP servers...");
	// TODO: Connect to MCP servers if configured

	// 9. Sandbox setup
	console.log("Setting up sandbox...");
	// TODO: Create ClusterFs and define commands

	// 10. Persona loading
	console.log("Loading persona...");
	// TODO: Load config/persona.md if exists

	// 11. LLM setup
	console.log("Initializing LLM...");
	// TODO: Create model router from config

	// 12. Web server
	console.log("Starting web server...");
	// TODO: Start Hono + WebSocket via @bound/web

	// 13. Discord (if configured)
	console.log("Initializing Discord...");
	// TODO: Start Discord bot if discord.json exists and host matches

	// 14. Sync (if configured)
	console.log("Initializing sync loop...");
	// TODO: Start sync loop if sync.json exists

	// 15. Overlay scanning (if configured)
	console.log("Initializing overlay scanner...");
	// TODO: Start overlay index scan if overlay.json exists

	// 16. Scheduler
	console.log("Starting scheduler...");
	// TODO: Start scheduler loop via @bound/agent

	console.log(`
Bound is running!
Operator: ${appContext.config.allowlist.default_web_user}

Open http://localhost:3000 in your browser to start chatting.

Press Ctrl+C to stop.
`);

	// Keep process alive and handle graceful shutdown
	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => {
			console.log("\nShutting down gracefully...");
			// TODO: Stop all services in reverse order
			resolve();
		});

		process.on("SIGTERM", () => {
			console.log("\nTerminating...");
			// TODO: Stop all services in reverse order
			resolve();
		});
	});
}
