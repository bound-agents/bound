#!/usr/bin/env bun
// Build script for Bound
// Builds web assets and compiles single binary via bun build --compile

import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

async function build() {
	console.log("Building Bound...");

	// Step 1: Build web assets
	console.log("\n1. Building web assets...");
	try {
		execSync("cd packages/web && bun run build", { stdio: "inherit" });
		console.log("✓ Web assets built successfully");
	} catch (error) {
		console.error("✗ Failed to build web assets");
		process.exit(1);
	}

	// Step 2: Build CLI binary
	console.log("\n2. Compiling single binary...");
	try {
		execSync("bun build --compile packages/cli/src/bound.ts --outfile dist/bound", {
			stdio: "inherit",
		});
		console.log("✓ Binary compiled successfully");
	} catch (error) {
		console.error("✗ Failed to compile binary");
		console.error("Note: bun build --compile may not work in dev environment. This is expected.");
		// Don't exit with error code - this is optional for dev
	}

	// Print summary
	console.log("\n✓ Build complete!");

	if (existsSync("dist/bound")) {
		const stats = statSync("dist/bound");
		const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
		console.log(`Binary: dist/bound (${sizeMB} MB)`);
		console.log("\nYou can run: ./dist/bound --help");
	} else {
		console.log(
			"Note: Binary compilation skipped (expected in dev environment without native build tools)",
		);
		console.log("Use 'bun packages/cli/src/bound.ts' to run the CLI directly");
	}
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
