import type { Database } from "bun:sqlite";

const DEFAULT_INSTRUCTIONS =
	"Review system state. If advisories need attention, address them. If tasks have failed, investigate. Otherwise, note what you observed.";

export function buildHeartbeatContext(db: Database, lastRunAt: string | null): string {
	const instructions = loadStandingInstructions(db);
	const advisorySection = buildAdvisorySection(db, lastRunAt);
	const taskSection = buildTaskSection(db, lastRunAt);
	const threadSection = buildThreadSection(db, lastRunAt);

	return `You are running a scheduled heartbeat check.

## Standing Instructions
${instructions}

## Advisories
${advisorySection}

## Recent Tasks
${taskSection}

## Thread Activity
${threadSection}

Review the above and take action on anything that needs attention.
If nothing needs attention, respond briefly with what you observed.`;
}

function loadStandingInstructions(db: Database): string {
	const row = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get("_heartbeat_instructions") as { value: string } | null;
	return row?.value ?? DEFAULT_INSTRUCTIONS;
}

interface AdvisoryRow {
	title: string;
	status: string;
	resolved_at: string | null;
}

function buildAdvisorySection(db: Database, lastRunAt: string | null): string {
	// Pending advisories
	const pending = db
		.prepare(
			"SELECT title FROM advisories WHERE deleted = 0 AND status = 'proposed' ORDER BY proposed_at ASC",
		)
		.all() as Array<{ title: string }>;

	const pendingText =
		pending.length > 0
			? `Pending (${pending.length}): ${pending.map((a) => a.title).join(", ")}`
			: "Pending (0): None";

	// Status changes since last run
	let changesText = "";
	if (lastRunAt) {
		const changes = db
			.prepare(
				"SELECT title, status FROM advisories WHERE deleted = 0 AND resolved_at > ? ORDER BY resolved_at DESC",
			)
			.all(lastRunAt) as AdvisoryRow[];

		if (changes.length > 0) {
			changesText = changes.map((a) => `- ${a.title}: ${a.status}`).join("\n");
		} else {
			changesText = "No changes since last check.";
		}
	} else {
		changesText = "First heartbeat run - no previous check to compare against.";
	}

	return `${pendingText}\n\nSince last check:\n${changesText}`;
}

interface TaskRow {
	trigger_spec: string;
	status: string;
	error: string | null;
	last_run_at: string;
}

function buildTaskSection(db: Database, lastRunAt: string | null): string {
	const cutoff = lastRunAt ?? new Date(0).toISOString();
	const tasks = db
		.prepare(
			`SELECT trigger_spec, status, error, last_run_at
			 FROM tasks
			 WHERE status IN ('completed', 'failed')
			   AND last_run_at > ?
			   AND deleted = 0
			 ORDER BY last_run_at DESC
			 LIMIT 5`,
		)
		.all(cutoff) as TaskRow[];

	if (tasks.length === 0) return "No recent task completions.";

	return tasks
		.map((t) => {
			let name: string;
			try {
				const spec = JSON.parse(t.trigger_spec);
				name = spec.type ?? t.trigger_spec;
			} catch (_error) {
				// Malformed trigger_spec JSON — use raw string
				name = t.trigger_spec;
			}
			const errorSnippet = t.error ? ` - Error: ${t.error.slice(0, 150)}` : "";
			return `- [${t.status}] ${name} (${t.last_run_at})${errorSnippet}`;
		})
		.join("\n");
}

interface ThreadActivityRow {
	id: string;
	title: string | null;
	msg_count: number;
}

function buildThreadSection(db: Database, lastRunAt: string | null): string {
	if (!lastRunAt) return "First heartbeat run - no previous check to compare against.";

	const threads = db
		.prepare(
			`SELECT t.id, t.title,
			        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.created_at > ?) as msg_count
			 FROM threads t
			 WHERE t.deleted = 0
			   AND t.last_message_at > ?
			 ORDER BY t.last_message_at DESC
			 LIMIT 10`,
		)
		.all(lastRunAt, lastRunAt) as ThreadActivityRow[];

	if (threads.length === 0) return "No thread activity since last check.";

	return threads
		.map((t) => `- ${t.title ?? "(untitled)"}: ${t.msg_count} new message(s)`)
		.join("\n");
}
