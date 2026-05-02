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
	const rows = db
		.prepare("SELECT id FROM advisories WHERE id LIKE ? AND deleted = 0 LIMIT 2")
		.all(`${trimmed}%`) as Array<{ id: string }>;
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

const advisorySchema = z.object({
	title: z.string().optional().describe("Advisory title (for creating)"),
	detail: z.string().optional().describe("Advisory detail/description (for creating)"),
	action: z.string().optional().describe("Recommended corrective action (for creating)"),
	impact: z.string().optional().describe("Impact description (for creating)"),
	list: z.boolean().optional().describe("List advisories"),
	list_status: z.string().optional().describe("Filter listed advisories by status"),
	approve: z.string().optional().describe("Advisory ID prefix to approve"),
	apply: z.string().optional().describe("Advisory ID prefix to apply"),
	dismiss: z.string().optional().describe("Advisory ID prefix to dismiss"),
	defer: z.string().optional().describe("Advisory ID prefix to defer"),
	defer_until: z.string().optional().describe("ISO date to defer until (default: 24h from now)"),
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
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(advisorySchema, raw, "advisory");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				// Create advisory
				if (input.title && input.detail) {
					const id = createAdvisory(
						ctx.db,
						{
							type: "general",
							status: "proposed",
							title: input.title.trim(),
							detail: input.detail.trim(),
							action: input.action?.trim() ?? null,
							impact: input.impact?.trim() ?? null,
							evidence: null,
						},
						ctx.siteId,
					);
					return `Advisory created: ${id}`;
				}

				// List advisories
				if (input.list) {
					let query = "SELECT id, type, status, title, detail FROM advisories WHERE deleted = 0";

					if (input.list_status) {
						query += " AND status = ?";
					} else {
						query += " AND status NOT IN ('applied', 'dismissed')";
					}
					query += " ORDER BY proposed_at DESC LIMIT 20";

					const rows = input.list_status
						? (ctx.db.prepare(query).all(input.list_status) as Array<{
								id: string;
								type: string;
								status: string;
								title: string;
								detail: string;
							}>)
						: (ctx.db.prepare(query).all() as Array<{
								id: string;
								type: string;
								status: string;
								title: string;
								detail: string;
							}>);

					if (rows.length === 0) {
						return "No advisories found.";
					}

					const lines = rows.map(
						(r) => `[${r.status}] ${r.title} (${r.id.slice(0, 8)})\n  ${r.detail.slice(0, 120)}`,
					);
					return lines.join("\n\n");
				}

				// Approve advisory
				if (input.approve) {
					const resolved = resolveAdvisoryId(ctx.db, input.approve);
					if (!resolved.ok) {
						return `Error: ${resolved.error}`;
					}
					const result = approveAdvisory(ctx.db, resolved.id, ctx.siteId);
					if (!result.ok) {
						return `Error: Failed to approve advisory: ${result.error.message}`;
					}
					return `Advisory ${resolved.id} approved.`;
				}

				// Apply advisory
				if (input.apply) {
					const resolved = resolveAdvisoryId(ctx.db, input.apply);
					if (!resolved.ok) {
						return `Error: ${resolved.error}`;
					}
					const result = applyAdvisory(ctx.db, resolved.id, ctx.siteId);
					if (!result.ok) {
						return `Error: Failed to apply advisory: ${result.error.message}`;
					}
					return `Advisory ${resolved.id} applied.`;
				}

				// Dismiss advisory
				if (input.dismiss) {
					const resolved = resolveAdvisoryId(ctx.db, input.dismiss);
					if (!resolved.ok) {
						return `Error: ${resolved.error}`;
					}
					const result = dismissAdvisory(ctx.db, resolved.id, ctx.siteId);
					if (!result.ok) {
						return `Error: Failed to dismiss advisory: ${result.error.message}`;
					}
					return `Advisory ${resolved.id} dismissed.`;
				}

				// Defer advisory
				if (input.defer) {
					const resolved = resolveAdvisoryId(ctx.db, input.defer);
					if (!resolved.ok) {
						return `Error: ${resolved.error}`;
					}
					const deferDate = input.defer_until || new Date(Date.now() + 24 * 3600_000).toISOString();
					const result = deferAdvisory(ctx.db, resolved.id, deferDate, ctx.siteId);
					if (!result.ok) {
						return `Error: Failed to defer advisory: ${result.error.message}`;
					}
					return `Advisory ${resolved.id} deferred.`;
				}

				return "Error: No operation specified. Use one of: title+detail (create), list, approve, apply, dismiss, defer";
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
