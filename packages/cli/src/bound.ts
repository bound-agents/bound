#!/usr/bin/env bun
// Entry point for the `bound` binary. The command implementation lives in
// bound-main.ts so tests can import `main` without triggering process.exit.

import { main } from "./bound-main.js";

try {
	process.exit(await main(process.argv.slice(2)));
} catch (error) {
	console.error("Fatal error:", error);
	process.exit(1);
}
