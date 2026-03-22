#!/usr/bin/env bun
// Build script for Bound
// Builds web assets (with embedded SPA) and compiles single binary

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

	// Step 2: Compile single binary
	console.log("\n2. Compiling single binary...");
	try {
		execSync("bun build --compile packages/cli/src/bound.ts --outfile dist/bound", {
			stdio: "inherit",
		});
	} catch {
		console.error("Binary compilation failed (expected in some dev environments)");
		console.log("Use 'bun packages/cli/src/bound.ts' to run directly");
	}

	// Summary
	if (existsSync("dist/bound")) {
		const sizeMB = (statSync("dist/bound").size / (1024 * 1024)).toFixed(2);
		console.log(`\nBinary: dist/bound (${sizeMB} MB)`);
	}
}

build().catch((error) => {
	console.error("Build failed:", error);
	process.exit(1);
});
