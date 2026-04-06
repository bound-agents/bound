#!/usr/bin/env bun
/**
 * Start test web server for E2E tests
 * Ensures the Svelte SPA is built before starting
 */

import { createAppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createWebServer } from "@bound/web";

async function main() {
	try {
		// Create app context for the test environment
		// Use temporary database for testing
		const ctx = createAppContext(".", ":memory:");

		// Create EventBus
		const eventBus = new TypedEventEmitter();

		// Create and start web server
		const webServer = await createWebServer(ctx.db, eventBus, {
			port: 3001,
			host: "localhost",
			operatorUserId: "test-operator",
		});

		await webServer.start();

		console.log(`Test server started at ${webServer.address()}`);

		// Keep the server running
		process.on("SIGTERM", async () => {
			console.log("Stopping test server...");
			await webServer.stop();
			process.exit(0);
		});

		process.on("SIGINT", async () => {
			console.log("Stopping test server...");
			await webServer.stop();
			process.exit(0);
		});
	} catch (error) {
		console.error("Failed to start test server:", error);
		process.exit(1);
	}
}

main();
