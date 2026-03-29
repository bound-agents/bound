#!/usr/bin/env bun
// Build script for Bound
// Builds web assets (with embedded SPA) and compiles all binaries

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

async function build() {
	console.log("Building Bound...\n");

	// Step 1: Build web assets + embed for binary
	console.log("1. Building web UI...");
	try {
		execSync("cd packages/web && bun run build", { stdio: "inherit" });
	} catch {
		console.error("Failed to build web assets");
		process.exit(1);
	}

	// Step 2: Compile bound (main agent binary)
	console.log("\n2. Compiling bound binary...");
	try {
		execSync("bun build --compile packages/cli/src/bound.ts --outfile dist/bound", {
			stdio: "inherit",
		});
	} catch {
		console.error("Binary compilation failed (expected in some dev environments)");
		console.log("Use 'bun packages/cli/src/bound.ts' to run directly");
	}

	// Step 3: Compile boundctl (management CLI)
	console.log("\n3. Compiling boundctl binary...");
	try {
		execSync("bun build --compile packages/cli/src/boundctl.ts --outfile dist/boundctl", {
			stdio: "inherit",
		});
	} catch {
		console.error("boundctl compilation failed");
		console.log("Use 'bun packages/cli/src/boundctl.ts' to run directly");
	}

	// Step 4: Compile bound-mcp (MCP stdio server)
	console.log("\n4. Compiling bound-mcp binary...");
	try {
		execSync("bun build --compile packages/mcp-server/src/server.ts --outfile dist/bound-mcp", {
			stdio: "inherit",
		});
	} catch {
		console.error("bound-mcp compilation failed");
		console.log("Use 'bun packages/mcp-server/src/server.ts' to run directly");
	}

	// Summary
	console.log("\n--- Build summary ---");
	for (const binary of ["dist/bound", "dist/boundctl", "dist/bound-mcp"]) {
		if (existsSync(binary)) {
			const sizeMB = (statSync(binary).size / (1024 * 1024)).toFixed(2);
			console.log(`  ${binary} (${sizeMB} MB)`);
		} else {
			console.log(`  ${binary} (not built)`);
		}
	}
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
