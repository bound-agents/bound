import {
	findAdvisoryIdsByPrefix,
	listActiveAdvisorySummaries,
	listAdvisorySummariesByStatus,
} from "@bound/core";
import { z } from "zod";
import {
	applyAdvisory,
	approveAdvisory,
	createAdvisory,
	deferAdvisory,
	dismissAdvisory,
} from "../advisories";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

/**
 * Resolve a (possibly prefix-truncated) advisory ID to the full UUID.
 */
function resolveAdvisoryId(
	db: import("bun:sqlite").Database,
	prefix: string,
): { ok: true; id: string } | { ok: false; error: string } {
	const trimmed = prefix.trim();
	const rows = findAdvisoryIdsByPrefix(db, trimmed);
	if (rows.length === 0) {
		return { ok: false, error: `No advisory found matching "${trimmed}"` };
	}
	if (rows.length > 1) {
		return {
			ok: false,
			error: `Ambiguous prefix "${trimmed}" — matches multiple advisories. Use a longer prefix.`,
		};
	}
	return { ok: true, id: rows[0].id };
}

// Action-enum dispatch (CONTRIBUTING: grouped tools use an `action` enum).
// The tool was previously flag-shaped — create fired whenever title+detail
// were truthy, checked BEFORE the other operations — which minted junk
// advisories on more than one occasion when a dismiss/list call also
// carried create-shaped params. The explicit enum makes the requested
// operation unambiguous.
const advisorySchema = z.object({
	action: z
		.enum(["create", "list", "approve", "apply", "dismiss", "defer"])
		.describe("Advisory operation to perform"),
	title: z.string().optional().describe("Advisory title (for create)"),
	detail: z.string().optional().describe("Advisory detail/description (for create)"),
	recommended_action: z.string().optional().describe("Recommended corrective action (for create)"),
	impact: z.string().optional().describe("Impact description (for create)"),
	list_status: z.string().optional().describe("Filter listed advisories by status (for list)"),
	id: z
		.string()
		.optional()
		.describe("Advisory ID or unique ID prefix (for approve/apply/dismiss/defer)"),
	note: z
		.string()
		.optional()
		.describe(
			"Rationale / outcome for a state change (required for approve/apply/dismiss/defer). Recorded as provenance so a later reader knows why the advisory was resolved.",
		),
	defer_until: z
		.string()
		.optional()
		.describe("ISO date to defer until (default: 24h from now) (for defer)"),
});

export function createAdvisoryTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(advisorySchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "advisory",
				description: "Post a proactive advisory for operator review",
				parameters: jsonSchema,
			},
		},
		// list → read-only; approve/apply/defer/dismiss → idempotent (terminal
		// status transitions); create → non-idempotent (each call inserts a new
		// advisory row with a fresh id).
		resolveAnnotations: (args: Record<string, unknown>) => {
			switch (args.action) {
				case "list":
					return { idempotent: true, readOnly: true };
				case "approve":
				case "apply":
				case "dismiss":
				case "defer":
					return { idempotent: true, readOnly: false };
				case "create":
					return { idempotent: false, readOnly: false };
				default:
					return {};
			}
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(advisorySchema, raw, "advisory");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				switch (input.action) {
					case "create": {
						const title = input.title?.trim();
						const detail = input.detail?.trim();
						if (!title || !detail) {
							return "Error: `title` and `detail` are required for action=create.";
						}
						const id = createAdvisory(
							ctx.db,
							{
								type: "general",
								status: "proposed",
								title,
								detail,
								action: input.recommended_action?.trim() ?? null,
								impact: input.impact?.trim() ?? null,
								evidence: null,
							},
							ctx.siteId,
							ctx.threadId ?? null,
						);
						return `Advisory created: ${id}`;
					}

					case "list": {
						const rows = input.list_status
							? listAdvisorySummariesByStatus(ctx.db, input.list_status)
							: listActiveAdvisorySummaries(ctx.db);

						if (rows.length === 0) {
							return "No advisories found.";
						}

						const lines = rows.map(
							(r) => `[${r.status}] ${r.title} (${r.id.slice(0, 8)})\n  ${r.detail.slice(0, 120)}`,
						);
						return lines.join("\n\n");
					}

					case "approve":
					case "apply":
					case "dismiss":
					case "defer": {
						// State transitions require a note recording why/what was
						// done — #192 provenance. The acting party on this surface
						// is always the agent.
						if (!input.id?.trim()) {
							return `Error: an \`id\` (advisory ID or unique prefix) is required for action=${input.action}.`;
						}
						const note = input.note?.trim();
						if (!note) {
							return "Error: a `note` is required when changing an advisory's state — record why it's being approved/applied/dismissed/deferred.";
						}
						const resolved = resolveAdvisoryId(ctx.db, input.id);
						if (!resolved.ok) {
							return `Error: ${resolved.error}`;
						}
						const resolution = { note, by: "agent" };

						switch (input.action) {
							case "approve": {
								const result = approveAdvisory(ctx.db, resolved.id, resolution, ctx.siteId);
								if (!result.ok) {
									return `Error: Failed to approve advisory: ${result.error.message}`;
								}
								return `Advisory ${resolved.id} approved.`;
							}
							case "apply": {
								const result = applyAdvisory(ctx.db, resolved.id, resolution, ctx.siteId);
								if (!result.ok) {
									return `Error: Failed to apply advisory: ${result.error.message}`;
								}
								return `Advisory ${resolved.id} applied.`;
							}
							case "dismiss": {
								const result = dismissAdvisory(ctx.db, resolved.id, resolution, ctx.siteId);
								if (!result.ok) {
									return `Error: Failed to dismiss advisory: ${result.error.message}`;
								}
								return `Advisory ${resolved.id} dismissed.`;
							}
							case "defer": {
								const deferDate =
									input.defer_until || new Date(Date.now() + 24 * 3600_000).toISOString();
								const result = deferAdvisory(
									ctx.db,
									resolved.id,
									deferDate,
									resolution,
									ctx.siteId,
								);
								if (!result.ok) {
									return `Error: Failed to defer advisory: ${result.error.message}`;
								}
								return `Advisory ${resolved.id} deferred.`;
							}
						}
						// Unreachable — the inner switch is exhaustive over the four
						// transition actions.
						break;
					}
				}
				return "Error: No operation specified. Use action=create|list|approve|apply|dismiss|defer.";
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
