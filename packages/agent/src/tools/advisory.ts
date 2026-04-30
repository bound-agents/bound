import {
	applyAdvisory,
	approveAdvisory,
	createAdvisory,
	deferAdvisory,
	dismissAdvisory,
} from "../advisories";
import type { RegisteredTool, ToolContext } from "../types";

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

export function createAdvisoryTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "advisory",
				description: "Post a proactive advisory for operator review",
				parameters: {
					type: "object",
					properties: {
						title: {
							type: "string",
							description: "Advisory title (for creating)",
						},
						detail: {
							type: "string",
							description: "Advisory detail/description (for creating)",
						},
						action: {
							type: "string",
							description: "Recommended corrective action (for creating)",
						},
						impact: {
							type: "string",
							description: "Impact description (for creating)",
						},
						list: {
							type: "boolean",
							description: "List advisories",
						},
						list_status: {
							type: "string",
							description: "Filter listed advisories by status",
						},
						approve: {
							type: "string",
							description: "Advisory ID prefix to approve",
						},
						apply: {
							type: "string",
							description: "Advisory ID prefix to apply",
						},
						dismiss: {
							type: "string",
							description: "Advisory ID prefix to dismiss",
						},
						defer: {
							type: "string",
							description: "Advisory ID prefix to defer",
						},
						defer_until: {
							type: "string",
							description: "ISO date to defer until (default: 24h from now)",
						},
					},
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			try {
				const title = input.title as string | undefined;
				const detail = input.detail as string | undefined;
				const action = input.action as string | undefined;
				const impact = input.impact as string | undefined;
				const list = input.list as boolean | undefined;
				const listStatus = input.list_status as string | undefined;
				const approve = input.approve as string | undefined;
				const apply = input.apply as string | undefined;
				const dismiss = input.dismiss as string | undefined;
				const defer = input.defer as string | undefined;
				const deferUntil = input.defer_until as string | undefined;

				// Create advisory
				if (title && detail) {
					const id = createAdvisory(
						ctx.db,
						{
							type: "general",
							status: "proposed",
							title: title.trim(),
							detail: detail.trim(),
							action: action?.trim() ?? null,
							impact: impact?.trim() ?? null,
							evidence: null,
						},
						ctx.siteId,
					);
					return `Advisory created: ${id}`;
				}

				// List advisories
				if (list) {
					let query = "SELECT id, type, status, title, detail FROM advisories WHERE deleted = 0";
					const params: (string | number | null)[] = [];

					if (listStatus) {
						query += " AND status = ?";
						params.push(listStatus);
					} else {
						query += " AND status NOT IN ('applied', 'dismissed')";
					}
					query += " ORDER BY proposed_at DESC LIMIT 20";

					const rows = ctx.db.prepare(query).all(...(params as any)) as Array<{
						id: string;
						type: string;
						status: string;
						title: string;
						detail: string;
					}>;

					if (rows.length === 0) {
						return "No advisories found.";
					}

					const lines = rows.map(
						(r) => `[${r.status}] ${r.title} (${r.id.slice(0, 8)})\n  ${r.detail.slice(0, 120)}`,
					);
					return lines.join("\n\n");
				}

				// Approve advisory
				if (approve) {
					const resolved = resolveAdvisoryId(ctx.db, approve);
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
				if (apply) {
					const resolved = resolveAdvisoryId(ctx.db, apply);
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
				if (dismiss) {
					const resolved = resolveAdvisoryId(ctx.db, dismiss);
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
				if (defer) {
					const resolved = resolveAdvisoryId(ctx.db, defer);
					if (!resolved.ok) {
						return `Error: ${resolved.error}`;
					}
					const deferDate = deferUntil || new Date(Date.now() + 24 * 3600_000).toISOString();
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
