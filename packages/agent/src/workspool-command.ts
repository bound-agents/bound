import {
	DURABLE_WORK_MAX_ATTEMPTS,
	type DurableWorkInspectionRow,
	getDurableWork,
	listDeadLetterDurableWork,
	listDurableWorkForInspection,
	purgeDurableWork,
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

function parseOlderThanMs(value: string | undefined): number | undefined | null {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function purge(
	args: Record<string, string>,
	ctx: { db: Parameters<typeof purgeDurableWork>[0] },
): CommandResult {
	const olderThanMs = parseOlderThanMs(args["older-than"]);
	if (olderThanMs === null) return result("--older-than must be a non-negative number", 1);
	const kind = args.kind;
	if (args["dead-lettered"] === "true") {
		const deleted = purgeDurableWork(ctx.db, { mode: "dead-lettered", kind, olderThanMs });
		return result(
			JSON.stringify({ purged: deleted, mode: "dead-lettered", kind: kind ?? null }, null, 2),
		);
	}
	if (args["all-unclaimed"] === "true") {
		const deleted = purgeDurableWork(ctx.db, {
			mode: "all-unclaimed",
			kind,
			olderThanMs,
			force: args.force === "true",
		});
		return result(
			JSON.stringify({ purged: deleted, mode: "all-unclaimed", kind: kind ?? null }, null, 2),
		);
	}
	return result("pass --dead-lettered or --all-unclaimed", 1);
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
			"",
			"  purge [--kind KIND] --dead-lettered | --all-unclaimed [--older-than MS] [--force]",
			"    Physically delete local residue. --dead-lettered removes dead letters of any target",
			"    (--older-than filters by age, no floor). --all-unclaimed removes pending or dead-lettered",
			"    rows: dead letters of any target, but pending rows only when local-targeted (dispatch",
			"    wakeups) — peer-targeted pending rows are the live spool-transfer queue and are excluded",
			"    without --force. The 1h pending floor is a HARD gate without --force: --older-than can only",
			"    narrow the window (older rows), never below the floor. --force lets --older-than apply as given",
			"    and lifts the peer-pending exclusion. Never touches claimed or transferring rows.",
		].join("\n"),
		args: [{ name: "action", required: true, description: "list, redrive, or purge" }],
		handler: async (args, ctx) => {
			const staleMs = parseStaleMs(args["stale-ms"]);
			if (staleMs === null) return result("--stale-ms must be a non-negative number", 1);
			if (args.action === "list") {
				const staleBefore = new Date(Date.now() - staleMs).toISOString();
				return result(
					JSON.stringify(listDurableWorkForInspection(ctx.db, staleBefore).map(formatRow), null, 2),
				);
			}
			if (args.action === "purge") return purge(args, ctx);
			if (args.action !== "redrive") return result("action must be list, redrive, or purge", 1);
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
