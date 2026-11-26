#!/usr/bin/env bun
// Entry point for the `boundctl` binary. The command implementation lives in
// boundctl-main.ts so tests can import `main` without triggering process.exit.

import { main } from "./boundctl-main.js";

try {
	process.exit(await main(process.argv.slice(2)));
} catch (error) {
	console.error("Fatal error:", error);
	process.exit(1);
}
