import type { Database } from "bun:sqlite";
import { Hono } from "hono";

export interface MetricsResponse {
	tokens: {
		byModel: Array<{
			model_id: string;
			tokens_in: number;
			tokens_out: number;
			cache_read: number;
			cache_write: number;
			cost_usd: number;
			turn_count: number;
		}>;
		timeline: Array<{ date: string; tokens_in: number; tokens_out: number; cost_usd: number }>;
		costByModelTimeline: Array<{ date: string; model_id: string; cost_usd: number }>;
		totals: {
			tokens_in: number;
			tokens_out: number;
			cost_usd: number;
			turn_count: number;
			error_count: number;
		};
	};
	relay: {
		byHost: Array<{
			peer_site_id: string;
			avg_latency_ms: number;
			p95_latency_ms: number;
			success_count: number;
			failure_count: number;
			expired_count: number;
		}>;
		recentCycles: Array<{
			direction: string;
			peer_site_id: string;
			kind: string;
			latency_ms: number | null;
			success: boolean;
			expired: boolean;
			created_at: string;
		}>;
		totals: {
			total_cycles: number;
			success_rate: number;
			avg_latency_ms: number;
			expired_count: number;
		};
	};
	context: {
		totals: {
			avg_cache_hit_rate: number;
			budget_pressure_count: number;
			avg_truncated_tokens: number;
			total_turns_with_debug: number;
		};
		timeline: Array<{
			date: string;
			cache_hit_rate: number;
			budget_pressure_pct: number;
			avg_context_utilization: number;
		}>;
	};
}

export function createMetricsRoutes(_db: Database): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			// Get query parameters
			const fromParam = c.req.query("from");
			const toParam = c.req.query("to");

			// Validate required parameters
			if (!fromParam) {
				return c.json(
					{ error: "Missing required parameter: from", details: "from parameter is required" },
					400,
				);
			}

			if (!toParam) {
				return c.json(
					{ error: "Missing required parameter: to", details: "to parameter is required" },
					400,
				);
			}

			// Parse dates
			let from: Date;
			let to: Date;

			try {
				from = new Date(fromParam);
				if (from.toString() === "Invalid Date") {
					throw new Error("Invalid date format");
				}
			} catch {
				return c.json(
					{ error: "Invalid 'from' date format", details: "Must be valid ISO 8601 date" },
					400,
				);
			}

			try {
				to = new Date(toParam);
				if (to.toString() === "Invalid Date") {
					throw new Error("Invalid date format");
				}
			} catch {
				return c.json(
					{ error: "Invalid 'to' date format", details: "Must be valid ISO 8601 date" },
					400,
				);
			}

			// Clamp to to current time if in the future
			const now = new Date();
			if (to > now) {
				to = now;
			}

			// Validate to > from
			if (to <= from) {
				return c.json(
					{
						error: "'to' must be after 'from'",
						details: `to (${to.toISOString()}) must be greater than from (${from.toISOString()})`,
					},
					400,
				);
			}

			// Determine bucketing mode
			const rangeMs = to.getTime() - from.getTime();
			const rangeDays = rangeMs / (24 * 3600 * 1000);
			const useHourly = rangeDays <= 2; // 48 hours = 2 days

			const fromISO = from.toISOString();
			const toISO = to.toISOString();

			// Query token metrics
			const byModelRows = _db
				.prepare(
					`SELECT
					model_id,
					SUM(tokens_in) as tokens_in,
					SUM(tokens_out) as tokens_out,
					SUM(COALESCE(tokens_cache_read, 0)) as cache_read,
					SUM(COALESCE(tokens_cache_write, 0)) as cache_write,
					SUM(COALESCE(cost_usd, 0)) as cost_usd,
					COUNT(*) as turn_count
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND deleted = 0
				GROUP BY model_id
				ORDER BY (tokens_in + tokens_out) DESC`,
				)
				.all(fromISO, toISO) as Array<{
				model_id: string;
				tokens_in: number;
				tokens_out: number;
				cache_read: number;
				cache_write: number;
				cost_usd: number;
				turn_count: number;
			}>;

			const timelineBucketFormat = useHourly
				? "strftime('%Y-%m-%dT%H:00', created_at)"
				: "date(created_at)";
			const timelineRows = _db
				.prepare(
					`SELECT
					${timelineBucketFormat} as date,
					SUM(tokens_in) as tokens_in,
					SUM(tokens_out) as tokens_out,
					SUM(COALESCE(cost_usd, 0)) as cost_usd
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND deleted = 0
				GROUP BY date
				ORDER BY date ASC`,
				)
				.all(fromISO, toISO) as Array<{
				date: string;
				tokens_in: number;
				tokens_out: number;
				cost_usd: number;
			}>;

			const costByModelTimelineRows = _db
				.prepare(
					`SELECT
					${timelineBucketFormat} as date,
					model_id,
					SUM(COALESCE(cost_usd, 0)) as cost_usd
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND deleted = 0
				GROUP BY date, model_id
				ORDER BY date ASC, model_id ASC`,
				)
				.all(fromISO, toISO) as Array<{
				date: string;
				model_id: string;
				cost_usd: number;
			}>;

			const totalsRow = _db
				.prepare(
					`SELECT
					SUM(tokens_in) as tokens_in,
					SUM(tokens_out) as tokens_out,
					SUM(COALESCE(cost_usd, 0)) as cost_usd,
					COUNT(*) as turn_count,
					SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND deleted = 0`,
				)
				.get(fromISO, toISO) as {
				tokens_in: number | null;
				tokens_out: number | null;
				cost_usd: number | null;
				turn_count: number | null;
				error_count: number | null;
			};

			// Query relay metrics (including aggregates for all cycles, not just those with latencies)
			const relayHostAggregatesRows = _db
				.prepare(
					`SELECT
					peer_site_id,
					AVG(latency_ms) as avg_latency_ms,
					SUM(success) as success_count,
					COUNT(*) - SUM(success) as failure_count,
					SUM(expired) as expired_count,
					COUNT(*) as total_cycles
				FROM relay_cycles
				WHERE created_at BETWEEN ? AND ?
				GROUP BY peer_site_id`,
				)
				.all(fromISO, toISO) as Array<{
				peer_site_id: string;
				avg_latency_ms: number | null;
				success_count: number | null;
				failure_count: number | null;
				expired_count: number | null;
				total_cycles: number | null;
			}>;

			// Get all latency values per host for P95 calculation (only those with non-NULL latency)
			const latenciesPerHost = _db
				.prepare(
					`SELECT peer_site_id, latency_ms
				FROM relay_cycles
				WHERE created_at BETWEEN ? AND ? AND latency_ms IS NOT NULL
				ORDER BY peer_site_id, latency_ms ASC`,
				)
				.all(fromISO, toISO) as Array<{
				peer_site_id: string;
				latency_ms: number;
			}>;

			// Group latencies by host and compute P95
			const latenciesByHostMap = new Map<string, number[]>();
			for (const row of latenciesPerHost) {
				if (!latenciesByHostMap.has(row.peer_site_id)) {
					latenciesByHostMap.set(row.peer_site_id, []);
				}
				latenciesByHostMap.get(row.peer_site_id)?.push(row.latency_ms);
			}

			const computeP95 = (values: number[]): number => {
				if (values.length === 0) return 0;
				const sorted = values.sort((a, b) => a - b);
				const index = Math.floor(sorted.length * 0.95);
				return sorted[Math.max(0, index - 1)] ?? 0;
			};

			// Build byHost with P95 values
			const relayByHost = relayHostAggregatesRows.map((row) => ({
				peer_site_id: row.peer_site_id,
				avg_latency_ms: row.avg_latency_ms ?? 0,
				p95_latency_ms: computeP95(latenciesByHostMap.get(row.peer_site_id) ?? []),
				success_count: row.success_count ?? 0,
				failure_count: row.failure_count ?? 0,
				expired_count: row.expired_count ?? 0,
			}));

			// Get recent relay cycles
			const recentCyclesRows = _db
				.prepare(
					`SELECT direction, peer_site_id, kind, latency_ms, success, expired, created_at
				FROM relay_cycles
				WHERE created_at BETWEEN ? AND ?
				ORDER BY created_at DESC
				LIMIT 50`,
				)
				.all(fromISO, toISO) as Array<{
				direction: string;
				peer_site_id: string;
				kind: string;
				latency_ms: number | null;
				success: number;
				expired: number;
				created_at: string;
			}>;

			// Compute relay totals from aggregates and latency map
			let totalRelayCycles = 0;
			let totalRelaySuccess = 0;
			let totalRelayExpired = 0;
			let totalRelayLatency = 0;
			let latencyCount = 0;

			for (const row of relayHostAggregatesRows) {
				totalRelayCycles += row.total_cycles ?? 0;
				totalRelaySuccess += row.success_count ?? 0;
				totalRelayExpired += row.expired_count ?? 0;
			}

			for (const latencies of latenciesByHostMap.values()) {
				for (const lat of latencies) {
					totalRelayLatency += lat;
					latencyCount++;
				}
			}

			const relayTotals = {
				total_cycles: totalRelayCycles,
				success_rate: totalRelayCycles > 0 ? totalRelaySuccess / totalRelayCycles : 0,
				avg_latency_ms: latencyCount > 0 ? totalRelayLatency / latencyCount : 0,
				expired_count: totalRelayExpired,
			};

			// Query context metrics
			const contextTotalsRow = _db
				.prepare(
					`SELECT
					COUNT(*) as total_turns_with_debug,
					AVG(
						CAST(COALESCE(tokens_cache_read, 0) AS REAL) /
						NULLIF(COALESCE(tokens_cache_read, 0) + tokens_in, 0)
					) as cache_hit_rate,
					SUM(CASE WHEN json_extract(context_debug, '$.budgetPressure') = 1 THEN 1 ELSE 0 END) as budget_pressure_count,
					AVG(COALESCE(CAST(json_extract(context_debug, '$.truncated') AS INTEGER), 0)) as avg_truncated_tokens
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND context_debug IS NOT NULL AND deleted = 0`,
				)
				.get(fromISO, toISO) as {
				total_turns_with_debug: number | null;
				cache_hit_rate: number | null;
				budget_pressure_count: number | null;
				avg_truncated_tokens: number | null;
			};

			// Query context timeline
			const contextTimelineRows = _db
				.prepare(
					`SELECT
					${timelineBucketFormat} as date,
					AVG(
						CAST(COALESCE(tokens_cache_read, 0) AS REAL) /
						NULLIF(COALESCE(tokens_cache_read, 0) + tokens_in, 0)
					) as cache_hit_rate,
					CAST(SUM(CASE WHEN json_extract(context_debug, '$.budgetPressure') = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as budget_pressure_pct,
					AVG(CAST(json_extract(context_debug, '$.totalEstimated') AS REAL) /
						NULLIF(CAST(json_extract(context_debug, '$.contextWindow') AS INTEGER), 0)) as avg_context_utilization
				FROM turns
				WHERE created_at BETWEEN ? AND ? AND context_debug IS NOT NULL AND deleted = 0
				GROUP BY date
				ORDER BY date ASC`,
				)
				.all(fromISO, toISO) as Array<{
				date: string;
				cache_hit_rate: number | null;
				budget_pressure_pct: number | null;
				avg_context_utilization: number | null;
			}>;

			// Build response with all queries populated
			const response: MetricsResponse = {
				tokens: {
					byModel: byModelRows || [],
					timeline: timelineRows || [],
					costByModelTimeline: costByModelTimelineRows || [],
					totals: {
						tokens_in: totalsRow?.tokens_in ?? 0,
						tokens_out: totalsRow?.tokens_out ?? 0,
						cost_usd: totalsRow?.cost_usd ?? 0,
						turn_count: totalsRow?.turn_count ?? 0,
						error_count: totalsRow?.error_count ?? 0,
					},
				},
				relay: {
					byHost: relayByHost,
					recentCycles: recentCyclesRows.map((row) => ({
						direction: row.direction,
						peer_site_id: row.peer_site_id,
						kind: row.kind,
						latency_ms: row.latency_ms,
						success: row.success === 1,
						expired: row.expired === 1,
						created_at: row.created_at,
					})),
					totals: relayTotals,
				},
				context: {
					totals: {
						avg_cache_hit_rate: contextTotalsRow?.cache_hit_rate ?? 0,
						budget_pressure_count: contextTotalsRow?.budget_pressure_count ?? 0,
						avg_truncated_tokens: contextTotalsRow?.avg_truncated_tokens ?? 0,
						total_turns_with_debug: contextTotalsRow?.total_turns_with_debug ?? 0,
					},
					timeline: contextTimelineRows.map((row) => ({
						date: row.date,
						cache_hit_rate: row.cache_hit_rate ?? 0,
						budget_pressure_pct: row.budget_pressure_pct ?? 0,
						avg_context_utilization: row.avg_context_utilization ?? 0,
					})),
				},
			};

			return c.json(response);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get metrics",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
