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
 *
 * Divergence audit (kept narrow on purpose).
 * Production constructs `AgentLoop` via `createAgentLoopFactory`
 * (`packages/cli/src/commands/start/agent-factory.ts`). The harness
 * deliberately deviates only where the daemon's wiring would force live
 * filesystem / sandbox / platform side effects. Every deviation either
 * (a) reuses a production helper, (b) is harmless on the harness hot path,
 * or (c) is documented as a known limitation.
 *
 * Reused unchanged from production:
 *   - `loadConfigFile` + `modelBackendsSchema` (config-loader)
 *   - `toRouterConfig` (Critical Invariant #17 hand-off)
 *   - `createModelRouter` + `createBackendFromConfig` (provider dispatch)
 *   - `applySchema` + `applyMetricsSchema` + `insertRow` (DB seed)
 *   - `InMemoryTurnStateStore` (already in-memory in production too)
 *   - `insertThreadMessage` (queues user prompts)
 *   - `estimateMaxTurnCost` (budget ceiling math)
 *   - The agent-loop's own `recordTurn` writes `cost_usd` via
 *     `calculateTurnCost(modelId, usage, ctx.config.modelBackends.backends)`
 *     — the harness reads from `cost_usd` in the in-memory `turns` row,
 *     never recomputes.
 *
 * Deliberate harness-side overrides (each has a one-line justification
 * elsewhere in this file):
 *   - Sandbox shim provides `exec` only. Production `loopSandbox` also
 *     provides `capturePreSnapshot`/`writeFile`/`persistFs`/`builtInTools`
 *     for VFS/sandbox flows. Fixtures use deterministic stubs so none of
 *     these hooks fire on the harness hot path; if a future agent-loop
 *     change starts requiring one, this comment is the first place to look.
 *   - No `hosts` row seeded. `hosts` is read by relay-router / mcp-bridge /
 *     model-resolution / hostinfo / summary-extraction. None of those
 *     fire on a fixture-driven turn (no relay, no MCP, single-backend
 *     router, no summary regen mid-fixture, no hostinfo tool). Skipping
 *     the seed avoids reaching for the `bootstrap.ts` outbox-exempt path.
 *   - `commandRegistry: []` and `optionalConfig: {}`. Context-assembly
 *     reads commandRegistry only for MCP bridge command rendering;
 *     fixtures don't use MCP. optionalConfig is read for sync — also
 *     unused on the harness path.
 *   - `eventBus` is a noop. Production emits `file:changed` /
 *     `changelog:written` etc. for sync. Harness has no sync.
 *   - `tools: undefined` in `AgentLoopConfig`. Production passes
 *     `[sandboxTool, ...builtInToolDefs, ...platformToolDefs]`, but
 *     `getMergedTools` reads from `toolRegistry` first and dedupes
 *     `tools` against the registry — so omitting `tools` is a no-op
 *     when every tool is already in the registry, which the harness
 *     enforces via its fixture loader.
 */

import type { Database } from "bun:sqlite";
import { insertRow, loadConfigFile } from "@bound/core";
import { createModelRouter } from "@bound/llm";
import type { ToolDefinition } from "@bound/llm";
import {
	type Logger,
	type ModelBackendsConfig as RawBackendsConfig,
	modelBackendsSchema,
} from "@bound/shared";
// `toRouterConfig` lives in the cli package; this is a known minor coupling
// (the harness needs the same SharedModelBackendsConfig → ModelBackendsConfig
// translation production uses for Critical Invariant #17 parity). Imported
// via relative path because cli has no package re-export and adding one
// would touch CI surface unrelated to the harness.
import { toRouterConfig } from "../../../cli/src/commands/start/inference";
// `@bound/agent` is the package this harness lives in; use relative paths to
// avoid the package self-reference resolution issue under tsc. The hermetic
// seed-and-run environment (in-memory DB, silent bus, AppContext stub, sandbox
// shim, AgentLoop construction) is shared with persona-lab via the harness
// core; only the wire-capture / budget / diagnostic logic is driver-specific.
import { estimateMaxTurnCost, insertThreadMessage } from "../../src/agent-loop-utils";
import { createHarnessEnvironment } from "../../src/harness/environment";
import type { RegisteredTool } from "../../src/types";
import { createCapturingFetch } from "./capture";
import type { Diagnostic, DiagnosticTurnData } from "./diagnostics/types";
import type { HarnessFixture, VolatilePrefixSeedSpec } from "./fixtures/types";

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
	/** Number of operator-driven user-turn iterations that completed. */
	userTurnsCompleted: number;
	/** Number of LLM inference calls observed (sum of inner-loop iterations). */
	inferencesObserved: number;
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
			userTurnsCompleted: 0,
			inferencesObserved: 0,
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

	// 6. Hermetic environment: in-memory DB with the full schema applied, a
	//    seeded user + thread, a silent event bus, and an AppContext stub —
	//    all shared with persona-lab via the harness core. The capturing
	//    router built above is injected so wire bodies are recorded per
	//    inference. Everything below (pre-seeded history, volatile-prefix
	//    seeding, tool registry, budget, diagnostics) is driver-specific and
	//    operates on the returned db / siteId / threadId / hostName.
	const env = createHarnessEnvironment({
		rawBackends,
		router,
		logger: opts.logger,
		threadTitle: opts.fixture.name,
		threadSummary: opts.fixture.threadSummary ?? null,
	});
	const { db, siteId, threadId, hostName, now } = env;

	// Pre-seed messages when the fixture defines them. Used by fixtures
	// that need a thread large enough to trigger truncation before turn 1.
	if (opts.fixture.preSeededMessages && opts.fixture.preSeededMessages.length > 0) {
		const startTime = new Date(now).getTime();
		const count = opts.fixture.preSeededMessages.length;
		for (let mi = 0; mi < count; mi++) {
			const pm = opts.fixture.preSeededMessages[mi];
			const msgTime = pm.created_at ?? new Date(startTime - (count - mi) * 1000).toISOString();
			insertRow(
				db,
				"messages",
				{
					id: deterministicUuid("msg", mi),
					thread_id: threadId,
					role: pm.role,
					content: pm.content,
					model_id: null,
					tool_name: null,
					host_origin: hostName,
					created_at: msgTime,
					modified_at: msgTime,
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
				siteId,
			);
		}
	}

	// `hosts` row would normally be bootstrapped via the daemon's start
	// path (outbox-exempt — see bootstrap.ts). Context-assembly only reads
	// `ctx.hostName` and `ctx.siteId` directly, so the harness can skip
	// host seeding without breaking any read path.

	// Seed volatile-prefix data when the fixture asks for it. Without
	// this, the volatile-prefix renders ~empty and `tokens_in` per
	// inference is artificially small — pushing cache hit rate toward
	// 100% in a way that doesn't predict production. With production-
	// scale counts the harness's hit rate lands in the production band.
	if (opts.fixture.volatilePrefix) {
		seedVolatilePrefix(db, siteId, now, opts.fixture.volatilePrefix);
	}

	// 7. Tool registry. Each fixture-declared tool becomes a RegisteredTool
	//    with a `kind: "builtin"` execute that calls the deterministic stub.
	const toolRegistry = buildToolRegistry(opts.fixture);

	// 10. Per-diagnostic record arrays.
	const perDiagRecords = new Map<string, Record<string, unknown>[]>();
	for (const d of opts.diagnostics) perDiagRecords.set(d.name, []);
	const rawTurnData: DiagnosticTurnData[] = [];

	// 11. Drive the turns loop.
	let userTurnsCompleted = 0;
	let inferenceCounter = 0;
	let abortReason: HarnessRunResult["abortReason"] = "completed";
	let abortMessage: string | null = null;

	for (let userTurn = 1; userTurn <= opts.turns; userTurn++) {
		// Per-user-turn budget projection.
		const before = sumTurnCosts(db, threadId);
		if (before + maxTurnCost > opts.budgetUsd) {
			abortReason = "per-turn-budget";
			abortMessage = `running cost ${before.toFixed(4)} + ceiling ${maxTurnCost.toFixed(4)} would exceed budget ${opts.budgetUsd.toFixed(2)} USD before user-turn ${userTurn}`;
			break;
		}

		// Inject user message for this user-turn.
		const userContent =
			userTurn === 1 ? opts.fixture.initialUserContent : mutationFor(userTurn - 1, opts.fixture);
		if (userContent) {
			insertThreadMessage(
				db,
				{ threadId, role: "user", content: userContent, hostOrigin: hostName },
				siteId,
			);
		}

		// Reset capture buffer for this user-turn.
		capturing.clear();
		// Snapshot turn-row count before the agent-loop runs so we can collect
		// the per-inference rows it adds during this user-turn.
		const turnsRowCountBefore = countTurnRows(db, threadId);

		// Build the loop config and run it against the shared environment.
		try {
			await env.runLoop({ modelId: picked.id, toolRegistry });
		} catch (err) {
			abortReason = "error";
			abortMessage = `user-turn ${userTurn} threw: ${(err as Error).message}`;
			break;
		}

		// One agent-loop run produces N main-loop inferences (the inner loop
		// spans multiple LLM calls when the agent issues tool calls, gets
		// results, and continues). Each main-loop inference writes ONE wire
		// body AND ONE row to the in-memory `turns` table (recordTurn from
		// the `done` chunk handler).
		//
		// AUXILIARY calls — `extractSummaryAndMemories`, title generation,
		// etc. — also flow through the same `LLMBackend.chat()` path and
		// thus ALSO produce wire bodies in `capturing.entries`, but they
		// do NOT write to the `turns` table. If we naively zip wires to
		// rows by index we mis-attribute auxiliary calls' (small, cheap,
		// summarizer-prompt) wire bodies to (large, expensive, agent-loop)
		// turn rows, producing nonsense diagnostic data.
		//
		// Filter: keep only wires whose system block looks like an
		// agent-loop stable prefix. The agent's system prompt always
		// starts with the byte-stable `**Environment.** You run inside
		// **bound**` literal (see `composeStablePrefix`). Auxiliary
		// callers compose their own short system prompts that don't
		// contain that literal, so filtering by it cleanly separates the
		// two channels without false positives.
		const newTurnRows = readTurnRowsAfter(db, threadId, turnsRowCountBefore);
		const allWires = capturing.entries.slice();
		const mainWires = allWires.filter(isAgentLoopWire);
		if (newTurnRows.length !== mainWires.length) {
			opts.logger.warn(
				`[harness] user-turn ${userTurn}: ${allWires.length} wires captured ` +
					`(${mainWires.length} main-loop, ${allWires.length - mainWires.length} auxiliary) ` +
					`but ${newTurnRows.length} turn rows recorded; aligning to min(rows, main-wires)`,
			);
		}
		const inferenceCount = Math.min(newTurnRows.length, mainWires.length);
		for (let i = 0; i < inferenceCount; i++) {
			inferenceCounter += 1;
			const turnData = buildTurnData(inferenceCounter, userTurn, newTurnRows[i], mainWires[i]);
			rawTurnData.push(turnData);
			for (const diag of opts.diagnostics) {
				perDiagRecords.get(diag.name)?.push(diag.collect(turnData));
			}
		}
		userTurnsCompleted = userTurn;

		// Hard-stop check.
		const after = sumTurnCosts(db, threadId);
		if (after > opts.budgetUsd * 1.05) {
			abortReason = "hard-stop-budget";
			abortMessage = `running cost ${after.toFixed(4)} exceeded budget ${opts.budgetUsd.toFixed(2)} USD (5% slack) after user-turn ${userTurn}`;
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
		userTurnsCompleted,
		inferencesObserved: inferenceCounter,
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

/**
 * Seed `semantic_memory` and `skills` rows so the volatile-prefix
 * renderer (`composeStableVolatileSubsection`) produces a body in the
 * production-scale range. Without seeded rows, the renderer emits
 * empty Working Knowledge / Discoverable Archive sections and the
 * harness's `tokens_in` per inference is artificially small.
 *
 * Determinism: the fixture spec specifies counts; this function
 * generates byte-stable rows with deterministic keys/values. Multiple
 * runs of the same harness invocation produce byte-identical seeds,
 * which is the precondition for byte-stable cache reads turn-over-turn.
 *
 * Seeded shape mirrors `loadPinnedEntries` / `loadSummaryEntries` /
 * `loadDetailEntries` queries in `summary-extraction.ts`:
 *   - `tier='pinned'` rows render as `- {key}: {value}` in full
 *   - `tier='summary'` rows render with value truncated to 200 chars
 *   - `tier='detail'` rows render as `- {key} (accessed YYYY-MM-DD)`
 *   - active `skills` render as `<skill><name>...</name>...</skill>`
 *
 * `last_accessed_at` is anchored to the harness's start time and never
 * advances during the run — production renderers strip this to a
 * `YYYY-MM-DD` calendar prefix (R-VC25 byte-stability invariant) so any
 * future drift surfaces as `_validation:stable-prefix-drift:*`.
 */
function seedVolatilePrefix(
	db: Database,
	siteId: string,
	now: string,
	spec: VolatilePrefixSeedSpec,
): void {
	const pinnedCount = spec.pinnedCount ?? 0;
	const pinnedValueChars = spec.pinnedValueChars ?? 2000;
	const summaryCount = spec.summaryCount ?? 0;
	const detailCount = spec.detailCount ?? 0;
	const skillCount = spec.skillCount ?? 0;

	for (let i = 0; i < pinnedCount; i++) {
		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUuid("pinned", i),
				key: `_pinned:harness:${String(i).padStart(4, "0")}`,
				value: synthesizeBlob(`pinned-${i}`, pinnedValueChars),
				source: null,
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
				tier: "pinned",
			},
			siteId,
		);
	}

	for (let i = 0; i < summaryCount; i++) {
		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUuid("summary", i),
				key: `summary:harness:${String(i).padStart(4, "0")}`,
				// Generate ~600 chars; the renderer truncates to 200.
				value: synthesizeBlob(`summary-${i}`, 600),
				source: null,
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
				tier: "summary",
			},
			siteId,
		);
	}

	for (let i = 0; i < detailCount; i++) {
		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUuid("detail", i),
				key: `detail:harness:topic-${String(i).padStart(4, "0")}:component-${i % 13}`,
				value: synthesizeBlob(`detail-${i}`, 1500),
				source: null,
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
				tier: "detail",
			},
			siteId,
		);
	}

	for (let i = 0; i < skillCount; i++) {
		insertRow(
			db,
			"skills",
			{
				id: deterministicUuid("skill", i),
				name: `harness-skill-${String(i).padStart(2, "0")}`,
				description: synthesizeBlob(`skill-desc-${i}`, 240),
				status: "active",
				skill_root: `skills/harness-skill-${i}`,
				content_hash: null,
				allowed_tools: null,
				compatibility: null,
				metadata_json: null,
				activated_at: now,
				created_by_thread: null,
				activation_count: 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
}

/**
 * Synthesize a stable blob of approximately the requested character
 * length. Uses the seed string repeated with a separator so byte
 * content is realistic-looking (multi-token-friendly) but trivially
 * deterministic. Truncated/padded to land at exactly `chars`.
 */
function synthesizeBlob(seed: string, chars: number): string {
	const filler = `${seed} sentence with words that compress reasonably well. `;
	let out = "";
	while (out.length < chars) out += filler;
	return out.slice(0, chars);
}

/**
 * Deterministic synthetic UUID. Used for seeded harness rows so multiple
 * invocations of the same fixture produce byte-identical DB content.
 */
function deterministicUuid(prefix: string, n: number): string {
	const num = String(n).padStart(8, "0");
	return `00000000-0000-0000-${prefix.slice(0, 4).padEnd(4, "x")}-${num}0000`;
}

/**
 * Discriminator: does this wire body look like an agent-loop main
 * inference call (vs an auxiliary call like summary extraction, title
 * generation, etc.)?
 *
 * The agent loop's stable prefix always opens with the literal
 * "**Environment.** You run inside **bound**" (see the persona block in
 * `compose-stable-prefix.ts`). Auxiliary callers (summary-extraction,
 * title-generation) compose their own much-shorter system prompts that
 * never contain that literal. Filtering by it cleanly separates the
 * two channels with no false positives.
 *
 * Without this filter the harness misattributes (small) auxiliary wire
 * bodies to (large) agent-loop turn rows by zip-index, producing
 * nonsense diagnostic data — e.g. a 6KB summarizer wire body paired
 * with a `cache_read_tokens=59,507` agent turn row, even though the
 * summarizer's prompt has nothing to do with the agent's cached prefix.
 */
const AGENT_PROMPT_SIGNATURE = "**Environment.** You run inside **bound**";

function isAgentLoopWire(wire: { url: string; body: string }): boolean {
	// The agent-loop stable prefix always carries the persona signature
	// literal; auxiliary callers (summary extraction, title generation) never
	// do. The literal's wire location is protocol-dependent: Bedrock/Anthropic
	// Converse bodies put it in a top-level `"system":[{"text":"..."}]` block,
	// while OpenAI-compatible bodies (the OpenCode Go GLM/Kimi/DeepSeek/MiMo
	// leg, plus the openai-compatible / cerebras / zai drivers) put it in a
	// `messages` array entry `{"role":"system","content":"..."}`. Anchoring to
	// the Bedrock JSON path silently dropped every OpenAI-compatible wire as
	// "auxiliary", which is why --dump-wire captured 0 turns for those models.
	// Match on the literal anywhere in the body so all wire shapes are seen;
	// the signature is unique enough that this keeps the no-false-positives
	// guarantee without parsing the full JSON.
	return wire.body.includes(AGENT_PROMPT_SIGNATURE);
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

/** Count the rows the agent loop has written so far for this thread. */
function countTurnRows(db: Database, threadId: string): number {
	const row = db
		.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM turns WHERE thread_id = ?")
		.get(threadId);
	return row?.n ?? 0;
}

/**
 * Read every `turns` row added since the count snapshot, ordered by
 * `created_at` ascending so the result lines up with `capturing.entries`
 * (both are emitted in `done`-chunk order by the agent loop).
 */
function readTurnRowsAfter(db: Database, threadId: string, previousCount: number): TurnRow[] {
	return db
		.query<TurnRow, [string, number]>(
			"SELECT context_debug, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write " +
				"FROM turns WHERE thread_id = ? " +
				"ORDER BY created_at ASC, rowid ASC " +
				"LIMIT -1 OFFSET ?",
		)
		.all(threadId, previousCount);
}

/**
 * Map one inference's `turns` row + captured wire body into the diagnostic
 * input shape. `recordTurn` always writes `cost_usd` via the agent loop's
 * `calculateTurnCost` against `ctx.config.modelBackends.backends` — the
 * harness reads from `cost_usd` only, never recomputes.
 */
function buildTurnData(
	inferenceIdx: number,
	userTurn: number,
	row: TurnRow,
	wire: { url: string; body: string },
): DiagnosticTurnData {
	let contextDebug: DiagnosticTurnData["contextDebug"] = null;
	let cachePath: DiagnosticTurnData["cachePath"] = "unknown";
	if (row.context_debug) {
		try {
			contextDebug = JSON.parse(row.context_debug) as DiagnosticTurnData["contextDebug"];
			const cp = (contextDebug as { cachePath?: string } | null)?.cachePath;
			if (cp === "cold" || cp === "warm") cachePath = cp;
		} catch {
			contextDebug = null;
		}
	}

	const usage =
		row.tokens_in !== null
			? {
					input_tokens: row.tokens_in ?? 0,
					output_tokens: row.tokens_out ?? 0,
					cache_read_tokens: row.tokens_cache_read,
					cache_write_tokens: row.tokens_cache_write,
					estimated: false,
				}
			: null;

	return {
		turn: inferenceIdx,
		userTurn,
		cachePath,
		wireBodies: [wire],
		usage,
		contextDebug,
		costUsd: row.cost_usd ?? 0,
	};
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
