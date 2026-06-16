/**
 * Shared in-memory AgentLoop harness environment.
 *
 * This module is DIAGNOSTIC / TEST INFRASTRUCTURE, not part of the daemon
 * runtime. Nothing on the production startup path imports it, so it is
 * tree-shaken out of the compiled binary. It lives under `src/` (rather than
 * `scripts/`) for one reason: `packages/agent/tsconfig.json` only typechecks
 * `src`, so placing the shared assembly here makes a future change to the
 * `AgentLoop` constructor a COMPILE error in both consumers rather than a
 * runtime surprise discovered only when someone next runs a harness.
 *
 * Two consumers build the same hermetic environment and used to each
 * re-derive it inline:
 *   - `scripts/agent-harness/driver.ts`   (cache / fidelity wire diagnostics)
 *   - `scripts/persona-lab/compare.ts`    (persona-iteration, emitted-content)
 *
 * The shared part is: a `:memory:` SQLite DB with the full schema applied, a
 * seeded user + thread, a silent logger + event bus, an `AppContext` stub, a
 * no-op sandbox shim, and a `runLoop` that constructs + runs one production
 * `AgentLoop` against all of it. The router is INJECTED by the caller — the
 * `toRouterConfig` translation (Critical Invariant #17) lives in the `cli`
 * package, and pulling `cli` into `@bound/agent`'s typecheck graph would be a
 * layering inversion. Each consumer keeps its own `toRouterConfig` +
 * capturing-fetch wiring and hands the finished router in here.
 *
 * Everything that diverges between the two consumers stays consumer-side and
 * operates on the returned `db` / `siteId` / `threadId` / `hostName`:
 * volatile-prefix seeding, persona `cluster_config` rows, fixture tool
 * registries, budget checks, wire capture, fault-band warnings, report
 * formatting. This module owns only the assembly they share verbatim.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	type AppContext,
	InMemoryTurnStateStore,
	applyMetricsSchema,
	applySchema,
	insertRow,
} from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import type {
	Logger,
	ModelBackendsConfig as RawBackendsConfig,
	TypedEventEmitter,
} from "@bound/shared";
import { InMemoryFs } from "just-bash";
import { AgentLoop } from "../agent-loop";
import type { AgentLoopConfig } from "../types";

const DEFAULT_TURN_STATE_TTL_MS = 55 * 60 * 1000;

/**
 * No-op sandbox. The `BashLike` interface the agent loop accepts has only
 * optional members, so an `exec` that returns empty success structurally
 * satisfies it. Harness fixtures stub their tools deterministically, so the
 * loop never invokes real bash on the hot path; this shim only catches an
 * unexpected exec call.
 */
const HARNESS_SANDBOX = {
	exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
};

export interface HarnessEnvironmentOptions {
	/**
	 * Full `model_backends.json`-shaped config. Threaded into
	 * `ctx.config.modelBackends` so the agent loop's `recordTurn` can compute
	 * `cost_usd` against real per-backend pricing.
	 */
	rawBackends: RawBackendsConfig;
	/**
	 * The model router to drive inference through. Built by the caller (so the
	 * `toRouterConfig` translation and any capturing-fetch override stay
	 * consumer-side). A typed stub is fine for environments that never call
	 * `runLoop`.
	 */
	router: ModelRouter;
	/** Logger. Defaults to a silent logger (no output unless overridden). */
	logger?: Logger;
	/** Stamped on seeded rows and `ctx.hostName`. Default `"agent-harness"`. */
	hostName?: string;
	/** `users.display_name`. Default `"harness"`. */
	userDisplayName?: string;
	/** `threads.title`. Default = `hostName`. */
	threadTitle?: string;
	/**
	 * `threads.summary`. When non-null, `summary_through` is stamped to the
	 * seed timestamp; when null, both stay null. Default null.
	 */
	threadSummary?: string | null;
	/** Per-thread turn-state TTL. Default 55 minutes (matches production). */
	turnStateTtlMs?: number;
}

/** Per-call overrides for one `AgentLoop` run. `threadId` / `userId` are
 *  supplied by the environment; everything else passes through. */
export type HarnessLoopConfig = Omit<AgentLoopConfig, "threadId" | "userId">;

export interface HarnessEnvironment {
	db: Database;
	ctx: AppContext;
	router: ModelRouter;
	siteId: string;
	userId: string;
	threadId: string;
	hostName: string;
	/** Seed timestamp shared by the user + thread rows. */
	now: string;
	/**
	 * Construct a fresh production `AgentLoop` against this environment and run
	 * it once. Safe to call repeatedly against the same environment — each call
	 * is a new loop instance over the same db / ctx / router, mirroring how the
	 * daemon constructs a loop per turn while reusing the AppContext.
	 */
	runLoop(config: HarnessLoopConfig): Promise<void>;
	/** Close the underlying database. */
	close(): void;
}

/** A logger whose methods are all no-ops and which reports every level
 *  disabled. `child` returns itself so callers can chain freely. */
export function silentLogger(): Logger {
	const logger: Logger = {
		trace() {},
		debug() {},
		info() {},
		warn() {},
		error() {},
		fatal() {},
		child() {
			return logger;
		},
		isLevelEnabled() {
			return false;
		},
	} as unknown as Logger;
	return logger;
}

/** An event bus whose methods are all no-ops. The harness has no sync, so
 *  `file:changed` / `changelog:written` emissions have nothing to drive. */
export function silentEventBus(): TypedEventEmitter {
	const noop = () => undefined;
	return {
		on: noop,
		off: noop,
		emit: noop,
		once: noop,
		removeAllListeners: noop,
	} as unknown as TypedEventEmitter;
}

/**
 * Build a hermetic in-memory environment with a seeded user + thread and an
 * `AppContext` ready to drive the production `AgentLoop`. The only outbound
 * side effects from a subsequent `runLoop` are the HTTPS calls the injected
 * router makes — nothing on disk changes.
 */
export function createHarnessEnvironment(opts: HarnessEnvironmentOptions): HarnessEnvironment {
	const logger = opts.logger ?? silentLogger();
	const hostName = opts.hostName ?? "agent-harness";

	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);

	const siteId = randomUUID();
	const userId = randomUUID();
	const threadId = randomUUID();
	const now = new Date().toISOString();

	const summary = opts.threadSummary ?? null;

	// Seed user + thread via the outbox helper (change-log compliant).
	insertRow(
		db,
		"users",
		{
			id: userId,
			display_name: opts.userDisplayName ?? "harness",
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
			title: opts.threadTitle ?? hostName,
			summary,
			summary_through: summary ? now : null,
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

	// `hosts` is intentionally not seeded: context assembly reads `ctx.siteId`
	// and `ctx.hostName` directly, and no relay / MCP / summary-regen path that
	// reads the `hosts` table fires on a fixture-driven turn. Seeding it would
	// reach for the daemon's outbox-exempt bootstrap path for no benefit.
	const ctx = {
		db,
		config: {
			allowlist: { users: [userId] },
			modelBackends: opts.rawBackends,
		},
		optionalConfig: {},
		eventBus: silentEventBus(),
		logger,
		siteId,
		hostName,
		turnStateStore: new InMemoryTurnStateStore(opts.turnStateTtlMs ?? DEFAULT_TURN_STATE_TTL_MS),
		commandRegistry: [],
		// `fs` is read by some agent-loop paths via `ctx as any`; attach for parity.
		fs: new InMemoryFs(),
	} as unknown as AppContext;

	return {
		db,
		ctx,
		router: opts.router,
		siteId,
		userId,
		threadId,
		hostName,
		now,
		async runLoop(config: HarnessLoopConfig): Promise<void> {
			const loop = new AgentLoop(ctx, HARNESS_SANDBOX, opts.router, {
				...config,
				threadId,
				userId,
			});
			await loop.run();
		},
		close(): void {
			db.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Emitted-content helpers
//
// The wire-observation seam (CapturedRequest / DiagnosticTurnData) sees the
// bytes sent TO the model. These helpers see what the model EMITTED — the
// assistant rows and turn metrics written back to the DB — which is the axis
// persona-lab needs and the original reason it forked its own harness instead
// of becoming an agent-harness diagnostic. They live here so any future
// emitted-content diagnostic can reuse them.
// ---------------------------------------------------------------------------

/** Count of assistant-role messages currently in the thread(s) of `db`. */
export function countAssistantMessages(db: Database): number {
	return (
		db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages WHERE role='assistant'").get()
			?.n ?? 0
	);
}

/** Content of the most recent assistant message, or `"(empty)"` if none. */
export function latestAssistantText(db: Database): string {
	return (
		db
			.query<{ content: string }, []>(
				"SELECT content FROM messages WHERE role='assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get()?.content ?? "(empty)"
	);
}

export interface LatestTurnMetrics {
	cost_usd: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
}

/** Cost + token counts for the most recent `turns` row, or null if none. */
export function latestTurnMetrics(db: Database): LatestTurnMetrics | null {
	return (
		db
			.query<LatestTurnMetrics, []>(
				"SELECT cost_usd, tokens_in, tokens_out FROM turns ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get() ?? null
	);
}
