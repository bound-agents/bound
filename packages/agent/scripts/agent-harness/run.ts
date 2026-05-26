#!/usr/bin/env bun
/**
 * Agent-loop diagnostic harness — CLI entry.
 *
 * Drives the production AgentLoop against a hermetic in-memory environment
 * with live LLM inference. Plugin-shaped diagnostics observe per-turn data
 * (cache markers, wire-body byte diffs, …) without restarting the daemon.
 *
 * `--budget <usd>` is required so cost is always a deliberate operator
 * decision; no env vars are consulted by the harness itself. Credentials
 * flow through whatever `model_backends.json` already configures for the
 * chosen `--backend`.
 *
 * Run:
 *   bun run packages/agent/scripts/agent-harness/run.ts --help
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args";
import { listDiagnostics, registerBuiltinDiagnostics } from "./diagnostics";
import { buildLogger, runHarness } from "./driver";
import { listFixtures, registerBuiltinFixtures } from "./fixtures";

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	registerBuiltinFixtures();
	registerBuiltinDiagnostics();

	const fixture = listFixtures().get(args.fixture);
	if (!fixture) {
		const known = Array.from(listFixtures().keys()).join(", ") || "(none registered)";
		fail(`fixture "${args.fixture}" not found. Available: ${known}`);
	}

	const diagnostics = args.diagnostics.map((name) => {
		const d = listDiagnostics().get(name);
		if (!d) {
			const known = Array.from(listDiagnostics().keys()).join(", ");
			fail(`diagnostic "${name}" not found. Available: ${known}`);
		}
		return d;
	});

	const logger = buildLogger(args.logLevel);
	const result = await runHarness({
		configDir: args.configDir,
		backend: args.backend,
		fixture,
		diagnostics,
		turns: args.turns,
		budgetUsd: args.budget,
		logger,
	});

	// Emit per-diagnostic reports.
	for (const [name, report] of result.perDiagnosticReports) {
		process.stdout.write(`\n=== diagnostic: ${name} ===\n`);
		process.stdout.write(report);
		if (!report.endsWith("\n")) process.stdout.write("\n");
	}

	// Cumulative footer.
	process.stdout.write("\n=== run summary ===\n");
	process.stdout.write(`turns_completed: ${result.turnsCompleted} / ${args.turns}\n`);
	process.stdout.write(`total_cost_usd:  ${result.totalCostUsd.toFixed(4)}\n`);
	process.stdout.write(`budget_usd:      ${args.budget.toFixed(2)}\n`);
	process.stdout.write(`abort_reason:    ${result.abortReason}\n`);
	if (result.abortMessage) {
		process.stdout.write(`abort_message:   ${result.abortMessage}\n`);
	}

	// Optional: dump raw wire bodies per turn for offline inspection.
	if (args.dumpWire) {
		const dir = args.dumpWire;
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		for (const turn of result.rawTurnData) {
			const path = join(dir, `turn-${turn.turn}.json`);
			writeFileSync(path, JSON.stringify(turn, null, 2));
		}
		process.stdout.write(
			`wire_dump:       ${dir}/turn-N.json (${result.rawTurnData.length} turns)\n`,
		);
	}

	// Exit 0 for clean completion or intentional budget aborts (the budget
	// flag was set by the operator on purpose, so hitting it isn't a
	// failure). Exit 1 only on unexpected errors (`abortReason: "error"`).
	process.exit(result.abortReason === "error" ? 1 : 0);
}

function fail(msg: string): never {
	process.stderr.write(`agent-harness: ${msg}\n`);
	process.exit(2);
}

main().catch((err) => {
	process.stderr.write(`agent-harness: unexpected error: ${(err as Error).stack ?? err}\n`);
	process.exit(1);
});
