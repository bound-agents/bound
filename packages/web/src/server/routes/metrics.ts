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
			latency_ms: number;
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
				WHERE created_at BETWEEN ? AND ?
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
				WHERE created_at BETWEEN ? AND ?
				GROUP BY date
				ORDER BY date ASC`,
				)
				.all(fromISO, toISO) as Array<{
				date: string;
				tokens_in: number;
				tokens_out: number;
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
				WHERE created_at BETWEEN ? AND ?`,
				)
				.get(fromISO, toISO) as {
				tokens_in: number | null;
				tokens_out: number | null;
				cost_usd: number | null;
				turn_count: number | null;
				error_count: number | null;
			};

			// Build response with token queries populated
			const response: MetricsResponse = {
				tokens: {
					byModel: byModelRows || [],
					timeline: timelineRows || [],
					totals: {
						tokens_in: totalsRow?.tokens_in ?? 0,
						tokens_out: totalsRow?.tokens_out ?? 0,
						cost_usd: Number((totalsRow?.cost_usd ?? 0).toFixed(2)),
						turn_count: totalsRow?.turn_count ?? 0,
						error_count: totalsRow?.error_count ?? 0,
					},
				},
				relay: {
					byHost: [],
					recentCycles: [],
					totals: {
						total_cycles: 0,
						success_rate: 0,
						avg_latency_ms: 0,
						expired_count: 0,
					},
				},
				context: {
					totals: {
						avg_cache_hit_rate: 0,
						budget_pressure_count: 0,
						avg_truncated_tokens: 0,
						total_turns_with_debug: 0,
					},
					timeline: [],
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
