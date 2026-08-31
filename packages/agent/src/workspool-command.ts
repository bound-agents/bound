import {
	DURABLE_WORK_MAX_ATTEMPTS,
	type DurableWorkInspectionRow,
	getDurableWork,
	listDeadLetterDurableWork,
	listDurableWorkForInspection,
	redriveDeadLetterDurableWork,
	redriveTransferringDurableWork,
} from "@bound/core";
import type { CommandDefinition, CommandResult } from "@bound/sandbox";
import { DURABLE_WORK_REGISTRY } from "./durable-work-registry";

const DEFAULT_STALE_MS = 60 * 60 * 1000;
const MAX_PREVIEW_CHARS = 512;

function result(stdout: string, exitCode = 0): CommandResult {
	return { stdout: `${stdout}\n`, stderr: "", exitCode };
}

function preview(payload: string): string {
	return payload.length > MAX_PREVIEW_CHARS
		? `${payload.slice(0, MAX_PREVIEW_CHARS - 1)}…`
		: payload;
}

function formatRow(row: DurableWorkInspectionRow): Record<string, unknown> {
	return {
		id: row.id,
		kind: row.kind,
		age_ms: row.age_ms,
		idempotency_key: row.idempotency_key,
		claim_state: row.claim_state,
		attempt_count: row.attempt_count,
		last_error: row.last_error,
		payload_preview: preview(row.payload),
	};
}

function ttlForKind(kind: string): number | null | undefined {
	return DURABLE_WORK_REGISTRY.find((entry) => entry.kind === kind)?.ttlMs;
}

function expiration(kind: string): string | null {
	const ttlMs = ttlForKind(kind);
	return ttlMs === undefined || ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString();
}

function parseStaleMs(value: string | undefined): number | null {
	if (value === undefined) return DEFAULT_STALE_MS;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function createWorkspoolCommand(): CommandDefinition {
	return {
		name: "workspool",
		description: "Inspect and redrive local durable work",
		helpText: [
			"Subcommands:",
			"",
			"  list [--stale-ms MS]",
			"    List dead-lettered rows and pending or processing rows older than MS (default: 3600000).",
			"",
			"  redrive --id ID | --kind KIND --all-dead-lettered",
			"    Return selected dead letters to pending. Existing attempts are preserved; registered TTLs restart.",
		].join("\n"),
		args: [{ name: "action", required: true, description: "list or redrive" }],
		handler: async (args, ctx) => {
			const staleMs = parseStaleMs(args["stale-ms"]);
			if (staleMs === null) return result("--stale-ms must be a non-negative number", 1);
			if (args.action === "list") {
				const staleBefore = new Date(Date.now() - staleMs).toISOString();
				return result(
					JSON.stringify(listDurableWorkForInspection(ctx.db, staleBefore).map(formatRow), null, 2),
				);
			}
			if (args.action !== "redrive") return result("action must be list or redrive", 1);
			const ids = args.id ? [args.id] : [];
			if (args["all-dead-lettered"] === "true") {
				if (!args.kind) return result("--kind is required with --all-dead-lettered", 1);
				const rows = listDeadLetterDurableWork(ctx.db, args.kind);
				ids.push(...rows.map((row) => row.id));
			}
			if (ids.length !== 1 && !args["all-dead-lettered"])
				return result("pass exactly one --id, or --kind with --all-dead-lettered", 1);
			const outcomes = ids.map((id) => {
				const row = getDurableWork(ctx.db, id);
				if (!row || row.claim_state === "consumed")
					return { id, outcome: "not found or already consumed" };
				// A wedged spool transfer (ack never returned) is reclaimed to pending so
				// the sender re-sends it; charging an attempt lets a poisoned row cap.
				// No registered-TTL gate: a transferring row already carries the RPC TTL
				// its producer set, and an operator naming it has judged it stuck.
				// A wedged spool transfer (ack never returned) is reclaimed to pending so
				// the sender re-sends it; charging an attempt lets a poisoned row cap and,
				// at the cap, dead-letter instead of looping. No registered-TTL gate: a
				// transferring row already carries the RPC TTL its producer set, and an
				// operator naming it has judged it stuck.
				if (row.claim_state === "transferring")
					return {
						id,
						outcome: redriveTransferringDurableWork(ctx.db, id, DURABLE_WORK_MAX_ATTEMPTS)
							? "redriven"
							: "not transferring",
					};
				if (ttlForKind(row.kind) === undefined)
					return { id, outcome: "rejected: unknown kind has no registered TTL" };
				return {
					id,
					outcome: redriveDeadLetterDurableWork(ctx.db, id, expiration(row.kind))
						? "redriven"
						: "not dead-lettered",
				};
			});
			return result(JSON.stringify(outcomes, null, 2));
		},
	};
}
