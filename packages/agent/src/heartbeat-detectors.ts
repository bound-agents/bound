/**
 * Deterministic SQL anomaly detectors for the heartbeat prompt; they report, never act.
 * Use JS-generated ISO parameters to avoid SQLite datetime lexicographic comparison bugs.
 */

import type { Database } from "bun:sqlite";

/** Minutes before now, as an ISO 8601 string for SQL parameter binding. */
function minutesAgoISO(minutes: number): string {
	return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function hoursAgoISO(hours: number): string {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

interface DetectorResult {
	/** Section heading shown in the prompt. */
	heading: string;
	/** Formatted findings, or null if nothing detected. */
	body: string | null;
}

// ─── A. In-flight task watchdog ─────────────────────────────────────

interface LongRunningTask {
	id: string;
	type: string;
	claimed_at: string;
	payload_snippet: string;
}

function detectLongRunningTasks(db: Database): DetectorResult {
	const cutoff = minutesAgoISO(15);
	const tasks = db
		.prepare(
			`SELECT id, type, claimed_at, substr(payload, 1, 80) AS payload_snippet
			 FROM tasks
			 WHERE status = 'running' AND claimed_at < ? AND deleted = 0
			 ORDER BY claimed_at ASC`,
		)
		.all(cutoff) as LongRunningTask[];

	if (tasks.length === 0) return { heading: "Long-running tasks", body: null };

	const now = Date.now();
	const lines = tasks.map((t) => {
		const elapsedMs = now - new Date(t.claimed_at).getTime();
		const elapsedMin = Math.round(elapsedMs / 60000);
		return `- ${t.type} task ${t.id}: running ${elapsedMin}min — ${t.payload_snippet}`;
	});

	return { heading: "Long-running tasks", body: lines.join("\n") };
}

// ─── B. Cost spike detector ──────────────────────────────────────────

interface CostSpike {
	task_id: string;
	turns: number;
	tokens_in: number;
	tokens_out: number;
}

function detectCostSpikes(db: Database, selfTaskId?: string): DetectorResult {
	const cutoff = minutesAgoISO(30);
	const rows = db
		.prepare(
			`SELECT task_id, COUNT(*) AS turns, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
			 FROM turns
			 WHERE created_at > ?
			 GROUP BY task_id
			 HAVING COUNT(*) > 20 OR SUM(tokens_in) > 500000
			 ORDER BY tokens_in DESC`,
		)
		.all(cutoff) as CostSpike[];

	const filtered = selfTaskId ? rows.filter((r) => r.task_id !== selfTaskId) : rows;

	if (filtered.length === 0) return { heading: "Cost spikes", body: null };

	const lines = filtered.map(
		(r) =>
			`- Task ${r.task_id}: ${r.turns} turns, ${r.tokens_in.toLocaleString()} tokens in, ${r.tokens_out.toLocaleString()} tokens out (30min window)`,
	);

	return { heading: "Cost spikes", body: lines.join("\n") };
}

// ─── C. Completed-but-not-surfaced tasks ─────────────────────────────

interface UnsurfacedTask {
	id: string;
	type: string;
	thread_id: string;
	last_run_at: string;
	payload_snippet: string;
}

function detectUnsurfacedTasks(db: Database): DetectorResult {
	const recentCutoff = hoursAgoISO(2);
	const graceCutoff = minutesAgoISO(5);

	const tasks = db
		.prepare(
			`SELECT id, type, thread_id, last_run_at, substr(payload, 1, 100) AS payload_snippet
			 FROM tasks
			 WHERE status = 'completed'
			   AND last_run_at > ?
			   AND last_run_at < ?
			   AND deleted = 0
			 ORDER BY last_run_at DESC`,
		)
		.all(recentCutoff, graceCutoff) as UnsurfacedTask[];

	if (tasks.length === 0) return { heading: "Unsurfaced completions", body: null };

	const lines = tasks.map(
		(t) =>
			`- ${t.type} task ${t.id} (thread ${t.thread_id}) completed ${t.last_run_at}: ${t.payload_snippet}`,
	);

	return { heading: "Unsurfaced completions", body: lines.join("\n") };
}

// ─── E. Unfollowed-up user thread ───────────────────────────────────

interface UnansweredThread {
	thread_id: string;
	last_user: string;
}

function detectUnansweredThreads(db: Database): DetectorResult {
	const cutoff = hoursAgoISO(6);

	const candidates = db
		.prepare(
			`SELECT thread_id,
			        MAX(CASE WHEN role='user' THEN created_at END) AS last_user,
			        MAX(CASE WHEN role='assistant' THEN created_at END) AS last_asst
			 FROM messages
			 WHERE created_at > ? AND deleted = 0
			 GROUP BY thread_id
			 HAVING last_user IS NOT NULL AND (last_asst IS NULL OR last_asst < last_user)`,
		)
		.all(cutoff) as UnansweredThread[];

	if (candidates.length === 0) return { heading: "Unanswered user threads", body: null };

	// Filter out mid-turn false positives: threads where the assistant is
	// mid-flight in an extended-tool-use turn (role='tool_call' with no
	// role='assistant' yet).
	const verified: UnansweredThread[] = [];
	for (const c of candidates) {
		const subsequent = db
			.prepare(
				`SELECT COUNT(*) AS n FROM messages
				 WHERE thread_id = ? AND role IN ('tool_call','assistant')
				   AND created_at > ? AND deleted = 0`,
			)
			.get(c.thread_id, c.last_user) as { n: number };

		if (subsequent.n === 0) {
			verified.push(c);
		}
	}

	if (verified.length === 0) return { heading: "Unanswered user threads", body: null };

	const lines = verified.map(
		(t) => `- Thread ${t.thread_id}: last user message ${t.last_user}, no assistant reply`,
	);

	return { heading: "Unanswered user threads", body: lines.join("\n") };
}

// ─── Memory pressure ────────────────────────────────────────────────

interface TierCount {
	tier: string;
	n: number;
}

function detectMemoryPressure(db: Database): DetectorResult {
	const rows = db
		.prepare("SELECT tier, COUNT(*) AS n FROM semantic_memory WHERE deleted=0 GROUP BY tier")
		.all() as TierCount[];

	const counts = new Map<string, number>();
	let total = 0;
	for (const r of rows) {
		counts.set(r.tier, r.n);
		total += r.n;
	}

	const defaultCount = counts.get("default") ?? 0;
	const overThreshold = total > 1200 || defaultCount > 500;

	if (!overThreshold) return { heading: "Memory pressure", body: null };

	const parts = rows.map((r) => `${r.tier}=${r.n}`).join(", ");
	return { heading: "Memory pressure", body: `${total} total (${parts}) — over threshold` };
}

// ─── Aggregator ─────────────────────────────────────────────────────

/**
 * Run all detectors and return a formatted section for the heartbeat prompt.
 * Returns null if no anomalies were detected.
 */
export function buildDetectorSection(db: Database, selfTaskId?: string): string | null {
	const results: DetectorResult[] = [
		detectLongRunningTasks(db),
		detectCostSpikes(db, selfTaskId),
		detectUnsurfacedTasks(db),
		detectUnansweredThreads(db),
		detectMemoryPressure(db),
	];

	const findings = results.filter((r) => r.body !== null);

	if (findings.length === 0) return null;

	return findings.map((r) => `### ${r.heading}\n${r.body}`).join("\n\n");
}
