/**
 * Agent-loop diagnostic harness driver.
 *
 * Drives N turns of the production `AgentLoop` against a hermetic in-memory
 * environment (`:memory:` SQLite + `InMemoryFs` + `InMemoryTurnStateStore`)
 * with live LLM inference. Captures wire bodies and per-turn metrics for
 * pluggable diagnostics.
 *
 * The hermeticity guarantee: nothing on disk changes (no production DB,
 * no production filesystem mutations). The only outbound side effects
 * are HTTPS calls to the configured LLM provider — which is the point.
 *
 * Cost discipline: three checkpoints against the operator-supplied
 * `--budget` (required, no default):
 *   1. Pre-flight estimate before turn 1.
 *   2. Per-turn projection before each turn.
 *   3. Hard stop after each turn (5% slack).
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	type AppContext,
	InMemoryTurnStateStore,
	applyMetricsSchema,
	applySchema,
	insertRow,
	loadConfigFile,
} from "@bound/core";
import { createModelRouter } from "@bound/llm";
import type { ModelRouter, ToolDefinition } from "@bound/llm";
import {
	type Logger,
	type ModelBackendsConfig as RawBackendsConfig,
	type TypedEventEmitter,
	modelBackendsSchema,
} from "@bound/shared";
import { InMemoryFs } from "just-bash";
// `toRouterConfig` lives in the cli package; this is a known minor coupling
// (the harness needs the same SharedModelBackendsConfig → ModelBackendsConfig
// translation production uses for Critical Invariant #17 parity). Imported
// via relative path because cli has no package re-export and adding one
// would touch CI surface unrelated to the harness.
import { toRouterConfig } from "../../../cli/src/commands/start/inference";
// `@bound/agent` is the package this harness lives in; use relative paths to
// avoid the package self-reference resolution issue under tsc.
import { AgentLoop } from "../../src/agent-loop";
import { calculateTurnCost, insertThreadMessage } from "../../src/agent-loop-utils";
import type { AgentLoopConfig, RegisteredTool } from "../../src/types";
import { createCapturingFetch } from "./capture";
import type { Diagnostic, DiagnosticTurnData } from "./diagnostics/types";
import type { HarnessFixture } from "./fixtures/types";

type RawBackendConfig = RawBackendsConfig["backends"][number];

export interface HarnessRunOptions {
	configDir: string;
	backend: string;
	fixture: HarnessFixture;
	diagnostics: Diagnostic[];
	turns: number;
	budgetUsd: number;
	logger: Logger;
}

export interface HarnessRunResult {
	turnsCompleted: number;
	totalCostUsd: number;
	abortReason: "completed" | "pre-flight-budget" | "per-turn-budget" | "hard-stop-budget" | "error";
	abortMessage: string | null;
	perDiagnosticReports: Map<string, string>;
	perDiagnosticRecords: Map<string, ReadonlyArray<Record<string, unknown>>>;
	rawTurnData: ReadonlyArray<DiagnosticTurnData>;
}

/**
 * Run the harness end-to-end. Returns a structured result; the caller
 * (`run.ts`) is responsible for formatting + writing to stdout.
 */
export async function runHarness(opts: HarnessRunOptions): Promise<HarnessRunResult> {
	// 1. Load model_backends.json — same path as production startup.
	const rawBackendsResult = loadConfigFile(
		opts.configDir,
		"model_backends.json",
		modelBackendsSchema,
	);
	if (!rawBackendsResult.ok) {
		throw new Error(
			`failed to load model_backends.json from ${opts.configDir}: ${rawBackendsResult.error.message}`,
		);
	}
	const rawBackends = rawBackendsResult.value;

	// 2. Pick the backend the operator selected (default → router default).
	const pickedId = opts.backend || rawBackends.default;
	const picked = rawBackends.backends.find((b: RawBackendConfig) => b.id === pickedId);
	if (!picked) {
		const known = rawBackends.backends.map((b: RawBackendConfig) => b.id).join(", ") || "(none)";
		throw new Error(`backend "${pickedId}" not found in model_backends.json. Available: ${known}`);
	}

	// 3. Pre-flight budget check — reject before any inference call when the
	//    worst-case ceiling already exceeds the budget.
	const maxTurnCost = estimateMaxTurnCost(picked);
	const projectedTotal = maxTurnCost * opts.turns;
	if (projectedTotal > opts.budgetUsd) {
		return {
			turnsCompleted: 0,
			totalCostUsd: 0,
			abortReason: "pre-flight-budget",
			abortMessage: `pre-flight estimate ${projectedTotal.toFixed(4)} USD exceeds budget ${opts.budgetUsd.toFixed(2)} USD (per-turn ceiling ${maxTurnCost.toFixed(4)} × ${opts.turns} turns)`,
			perDiagnosticReports: new Map(),
			perDiagnosticRecords: new Map(),
			rawTurnData: [],
		};
	}

	// 4. Translate the picked backend through toRouterConfig — same path the
	//    production daemon uses (Critical Invariant #17). One-backend
	//    ModelBackendsConfig with the picked entry as the default.
	const routerConfig = toRouterConfig({
		backends: [picked],
		default: picked.id,
	});

	// 5. Capturing fetch wraps globalThis.fetch and records each outgoing
	//    request body. `createModelRouter` threads it down to the driver
	//    constructor via the new `fetchByBackendId` option.
	const capturing = createCapturingFetch();
	const router = createModelRouter(routerConfig, {
		logger: opts.logger,
		fetchByBackendId: new Map([[picked.id, capturing.fetch]]),
	});

	// 6. Hermetic environment.
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);

	const siteId = randomUUID();
	const userId = randomUUID();
	const threadId = randomUUID();
	const hostName = "agent-harness";

	// Seed users + thread rows. Outbox-compliant via insertRow.
	const now = new Date().toISOString();
	insertRow(
		db,
		"users",
		{
			id: userId,
			display_name: "harness",
			platform_ids: null,
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: userId,
			interface: "harness",
			host_origin: siteId,
			color: 0,
			title: opts.fixture.name,
			summary: opts.fixture.threadSummary ?? null,
			summary_through: opts.fixture.threadSummary ? now : null,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
			model_hint: null,
		},
		siteId,
	);
	// `hosts` row would normally be bootstrapped via the daemon's start
	// path (outbox-exempt — see bootstrap.ts). Context-assembly only reads
	// `ctx.hostName` and `ctx.siteId` directly, so the harness can skip
	// host seeding without breaking any read path.

	const fs = new InMemoryFs();

	// 7. AppContext stub. Mirrors the shape of the production AppContext;
	//    silent event bus + logger keep the harness output clean unless
	//    the operator passes --log-level.
	const ctx = {
		db,
		config: {
			allowlist: { users: [userId] },
			modelBackends: rawBackends,
		},
		optionalConfig: {},
		eventBus: silentEventBus(),
		logger: opts.logger,
		siteId,
		hostName,
		turnStateStore: new InMemoryTurnStateStore(55 * 60 * 1000),
		commandRegistry: [],
		// `fs` is read by some agent-loop paths via `ctx as any`; attach for parity.
		fs,
	} as unknown as AppContext;

	// 8. Sandbox shim. The harness fixture's tools are stubbed deterministically
	//    so the agent loop never invokes real bash. The shim returns empty
	//    success for any unexpected exec call.
	const sandbox = {
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
	};

	// 9. Tool registry. Each fixture-declared tool becomes a RegisteredTool
	//    with a `kind: "builtin"` execute that calls the deterministic stub.
	const toolRegistry = buildToolRegistry(opts.fixture);

	// 10. Per-diagnostic record arrays.
	const perDiagRecords = new Map<string, Record<string, unknown>[]>();
	for (const d of opts.diagnostics) perDiagRecords.set(d.name, []);
	const rawTurnData: DiagnosticTurnData[] = [];

	// 11. Drive the turns loop.
	let turnsCompleted = 0;
	let abortReason: HarnessRunResult["abortReason"] = "completed";
	let abortMessage: string | null = null;

	for (let turn = 1; turn <= opts.turns; turn++) {
		// Per-turn budget projection.
		const before = sumTurnCosts(db, threadId);
		if (before + maxTurnCost > opts.budgetUsd) {
			abortReason = "per-turn-budget";
			abortMessage = `running cost ${before.toFixed(4)} + ceiling ${maxTurnCost.toFixed(4)} would exceed budget ${opts.budgetUsd.toFixed(2)} USD before turn ${turn}`;
			break;
		}

		// Inject user message for this turn.
		const userContent =
			turn === 1 ? opts.fixture.initialUserContent : mutationFor(turn - 1, opts.fixture);
		if (userContent) {
			insertThreadMessage(
				db,
				{ threadId, role: "user", content: userContent, hostOrigin: hostName },
				siteId,
			);
		}

		// Reset capture buffer for this turn.
		capturing.clear();

		// Build the loop config and run.
		const config: AgentLoopConfig = {
			threadId,
			userId,
			modelId: picked.id,
			toolRegistry,
		};
		const loop = new AgentLoop(ctx, sandbox, router as ModelRouter, config);
		try {
			await loop.run();
		} catch (err) {
			abortReason = "error";
			abortMessage = `turn ${turn} threw: ${(err as Error).message}`;
			break;
		}

		// Collect per-turn data from the in-memory `turns` table.
		const turnData = collectTurnData(db, threadId, turn, capturing.entries.slice(), [picked]);
		rawTurnData.push(turnData);
		for (const diag of opts.diagnostics) {
			perDiagRecords.get(diag.name)?.push(diag.collect(turnData));
		}
		turnsCompleted = turn;

		// Hard-stop check.
		const after = sumTurnCosts(db, threadId);
		if (after > opts.budgetUsd * 1.05) {
			abortReason = "hard-stop-budget";
			abortMessage = `running cost ${after.toFixed(4)} exceeded budget ${opts.budgetUsd.toFixed(2)} USD (5% slack) after turn ${turn}`;
			break;
		}
	}

	// 12. Render diagnostics.
	const perDiagReports = new Map<string, string>();
	for (const diag of opts.diagnostics) {
		const records = perDiagRecords.get(diag.name) ?? [];
		perDiagReports.set(diag.name, diag.render(records));
	}

	const totalCostUsd = sumTurnCosts(db, threadId);
	db.close();

	return {
		turnsCompleted,
		totalCostUsd,
		abortReason,
		abortMessage,
		perDiagnosticReports: perDiagReports,
		perDiagnosticRecords: new Map(
			Array.from(perDiagRecords.entries()).map(([k, v]) => [
				k,
				v as ReadonlyArray<Record<string, unknown>>,
			]),
		),
		rawTurnData,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Worst-case dollar cost for a single turn. */
function estimateMaxTurnCost(backend: RawBackendConfig): number {
	const ctx = backend.context_window ?? 200_000;
	const max = backend.max_output_tokens ?? 8_000;
	const inputPrice = backend.price_per_m_input ?? 0;
	const outputPrice = backend.price_per_m_output ?? 0;
	return (ctx * inputPrice + max * outputPrice) / 1_000_000;
}

/** Sum of `cost_usd` across all turn rows for the harness thread. */
function sumTurnCosts(db: Database, threadId: string): number {
	const row = db
		.query<{ total: number | null }, [string]>(
			"SELECT COALESCE(SUM(cost_usd), 0) AS total FROM turns WHERE thread_id = ?",
		)
		.get(threadId);
	return row?.total ?? 0;
}

function mutationFor(afterTurn: number, fixture: HarnessFixture): string | null {
	const m = fixture.perTurnMutations?.find((x) => x.afterTurn === afterTurn);
	return m?.insertUser ?? null;
}

function buildToolRegistry(fixture: HarnessFixture): Map<string, RegisteredTool> {
	const reg = new Map<string, RegisteredTool>();
	for (const td of fixture.tools) {
		const stub = fixture.toolStubs[td.function.name];
		if (!stub) {
			throw new Error(
				`fixture "${fixture.name}" declares tool "${td.function.name}" without a matching toolStubs entry`,
			);
		}
		reg.set(td.function.name, {
			kind: "builtin",
			toolDefinition: td,
			execute: async (input: Record<string, unknown>) => stub(input),
			idempotent: true,
			readOnly: true,
		});
	}
	return reg;
}

interface TurnRow {
	context_debug: string | null;
	cost_usd: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
}

function collectTurnData(
	db: Database,
	threadId: string,
	turn: number,
	wireBodies: ReadonlyArray<{ url: string; body: string }>,
	pricingBackends: RawBackendConfig[],
): DiagnosticTurnData {
	// Most recent turn row for this thread.
	const row = db
		.query<TurnRow, [string]>(
			"SELECT context_debug, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId);

	let contextDebug: DiagnosticTurnData["contextDebug"] = null;
	let cachePath: DiagnosticTurnData["cachePath"] = "unknown";
	if (row?.context_debug) {
		try {
			contextDebug = JSON.parse(row.context_debug) as DiagnosticTurnData["contextDebug"];
			const cp = (contextDebug as { cachePath?: string } | null)?.cachePath;
			if (cp === "cold" || cp === "warm") cachePath = cp;
		} catch {
			contextDebug = null;
		}
	}

	const usage =
		row && row.tokens_in !== null
			? {
					input_tokens: row.tokens_in ?? 0,
					output_tokens: row.tokens_out ?? 0,
					cache_read_tokens: row.tokens_cache_read,
					cache_write_tokens: row.tokens_cache_write,
					estimated: false,
				}
			: null;

	let costUsd = row?.cost_usd ?? 0;
	// `recordTurn` writes cost_usd; recompute here as a fallback for legacy
	// turns that didn't populate it. Reuses the same cost helper the
	// production agent loop uses.
	if (costUsd === 0 && usage && pricingBackends.length > 0) {
		costUsd = calculateTurnCost(
			pricingBackends[0].id,
			{
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				cacheReadTokens: usage.cache_read_tokens,
				cacheWriteTokens: usage.cache_write_tokens,
			},
			pricingBackends.map((b) => ({
				id: b.id,
				price_per_m_input: b.price_per_m_input,
				price_per_m_output: b.price_per_m_output,
				price_per_m_cache_read: b.price_per_m_cache_read,
				price_per_m_cache_write: b.price_per_m_cache_write,
			})),
		);
	}

	return {
		turn,
		cachePath,
		wireBodies,
		usage,
		contextDebug,
		costUsd,
	};
}

function silentEventBus(): TypedEventEmitter {
	const noop = () => undefined;
	return {
		on: noop,
		off: noop,
		emit: noop,
		once: noop,
		removeAllListeners: noop,
	} as unknown as TypedEventEmitter;
}

type LogLevel = "silent" | "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_RANK: Record<LogLevel, number> = {
	silent: Number.POSITIVE_INFINITY,
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
};

/**
 * Build a console-backed logger at the requested level. The harness avoids
 * pulling pino as a dependency — the agent-loop only needs the structural
 * methods (`debug` / `info` / `warn` / `error` + `child` + `isLevelEnabled`).
 * For diagnostic runs the operator typically wants `silent` (default) or
 * `debug` (to surface AI SDK request bodies via the existing fetch logger).
 */
export function buildLogger(logLevel: LogLevel): Logger {
	const threshold = LEVEL_RANK[logLevel];
	const make = (level: LogLevel, fn: (...args: unknown[]) => void) =>
		LEVEL_RANK[level] >= threshold
			? (msg: unknown, ...rest: unknown[]) => fn(`[${level}]`, msg, ...rest)
			: () => undefined;
	const logger: Logger = {
		trace: make("trace", console.log),
		debug: make("debug", console.log),
		info: make("info", console.log),
		warn: make("warn", console.warn),
		error: make("error", console.error),
		fatal: make("fatal", console.error),
		child: () => logger,
		isLevelEnabled: (level: string) =>
			(LEVEL_RANK[level as LogLevel] ?? Number.POSITIVE_INFINITY) >= threshold,
	} as unknown as Logger;
	return logger;
}

// Re-export ToolDefinition type for fixtures.
export type { ToolDefinition };
