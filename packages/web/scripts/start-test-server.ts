#!/usr/bin/env bun
/**
 * Start test web server for E2E tests.
 * Creates minimal config files in a temp directory and starts the server
 * with an in-memory database.
 *
 * Must be located within a workspace package directory so Bun can resolve
 * @bound/* workspace packages correctly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createWebServer } from "../src/index";

// Create minimal config files in a temp directory
const configDir = join(tmpdir(), `bound-test-${Date.now()}`);
mkdirSync(configDir, { recursive: true });

writeFileSync(
	join(configDir, "allowlist.json"),
	JSON.stringify({
		default_web_user: "test-user",
		users: {
			"test-user": { display_name: "Test User" },
		},
	}),
);

writeFileSync(
	join(configDir, "model_backends.json"),
	JSON.stringify({
		backends: [
			{
				id: "test-model",
				provider: "ollama",
				model: "test",
				base_url: "http://localhost:11434",
				context_window: 4096,
				tier: 1,
			},
		],
		default: "test-model",
	}),
);

async function main() {
	try {
		const ctx = createAppContext(configDir, ":memory:");
		const eventBus = new TypedEventEmitter();
		const webServer = await createWebServer(ctx.db, eventBus, {
			port: 3000,
			host: "localhost",
		});
		await webServer.start();
		console.log(`Test server started at ${webServer.address()}`);

		process.on("SIGTERM", async () => {
			await webServer.stop();
			process.exit(0);
		});
		process.on("SIGINT", async () => {
			await webServer.stop();
			process.exit(0);
		});
	} catch (error) {
		console.error("Failed to start test server:", error);
		process.exit(1);
	}
}

main();
