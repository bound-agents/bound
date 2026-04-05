import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import {
	applyAdvisory,
	approveAdvisory,
	createAdvisory,
	deferAdvisory,
	dismissAdvisory,
} from "../advisories";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

function handleCreate(args: Record<string, string>, ctx: CommandContext) {
	const title = args.title || args.source;
	const detail = args.detail || args.target;

	if (!title?.trim()) {
		return commandError("Missing required argument: title");
	}
	if (!detail?.trim()) {
		return commandError("Missing required argument: detail");
	}

	const id = createAdvisory(
		ctx.db,
		{
			type: "general",
			status: "proposed",
			title: title.trim(),
			detail: detail.trim(),
			action: args.action?.trim() ?? null,
			impact: args.impact?.trim() ?? null,
			evidence: null,
		},
		ctx.siteId,
	);

	return commandSuccess(`Advisory created: ${id}\n`);
}

function handleDismiss(args: Record<string, string>, ctx: CommandContext) {
	const id = args.source || args.id;
	if (!id?.trim()) {
		return commandError("usage: advisory dismiss <id>");
	}
	const result = dismissAdvisory(ctx.db, id.trim(), ctx.siteId);
	if (!result.ok) {
		return commandError(`Failed to dismiss advisory: ${result.error.message}`);
	}
	return commandSuccess(`Advisory ${id} dismissed.\n`);
}

function handleApprove(args: Record<string, string>, ctx: CommandContext) {
	const id = args.source || args.id;
	if (!id?.trim()) {
		return commandError("usage: advisory approve <id>");
	}
	const result = approveAdvisory(ctx.db, id.trim(), ctx.siteId);
	if (!result.ok) {
		return commandError(`Failed to approve advisory: ${result.error.message}`);
	}
	return commandSuccess(`Advisory ${id} approved.\n`);
}

function handleApply(args: Record<string, string>, ctx: CommandContext) {
	const id = args.source || args.id;
	if (!id?.trim()) {
		return commandError("usage: advisory apply <id>");
	}
	const result = applyAdvisory(ctx.db, id.trim(), ctx.siteId);
	if (!result.ok) {
		return commandError(`Failed to apply advisory: ${result.error.message}`);
	}
	return commandSuccess(`Advisory ${id} applied.\n`);
}

function handleDefer(args: Record<string, string>, ctx: CommandContext) {
	const id = args.source || args.id;
	if (!id?.trim()) {
		return commandError("usage: advisory defer <id>");
	}
	const deferUntil = args.until || new Date(Date.now() + 24 * 3600_000).toISOString();
	const result = deferAdvisory(ctx.db, id.trim(), deferUntil, ctx.siteId);
	if (!result.ok) {
		return commandError(`Failed to defer advisory: ${result.error.message}`);
	}
	return commandSuccess(`Advisory ${id} deferred.\n`);
}

function handleList(args: Record<string, string>, ctx: CommandContext) {
	const statusFilter = args.status;
	let query = "SELECT id, type, status, title, detail FROM advisories WHERE deleted = 0";
	const params: string[] = [];

	if (statusFilter) {
		query += " AND status = ?";
		params.push(statusFilter);
	} else {
		query += " AND status NOT IN ('applied', 'dismissed')";
	}
	query += " ORDER BY proposed_at DESC LIMIT 20";

	const rows = ctx.db.prepare(query).all(...params) as Array<{
		id: string;
		type: string;
		status: string;
		title: string;
		detail: string;
	}>;

	if (rows.length === 0) {
		return commandSuccess("No advisories found.\n");
	}

	const lines = rows.map(
		(r) => `[${r.status}] ${r.title} (${r.id.slice(0, 8)})\n  ${r.detail.slice(0, 120)}`,
	);
	return commandSuccess(`${lines.join("\n\n")}\n`);
}

export const advisory: CommandDefinition = {
	name: "advisory",
	args: [
		{
			name: "subcommand",
			required: false,
			description: "Subcommand: create, dismiss, approve, apply, defer, list",
		},
		{
			name: "source",
			required: false,
			description: "Advisory ID (for dismiss/approve/apply/defer) or title (for create)",
		},
		{ name: "target", required: false, description: "Detail text (for create)" },
		{ name: "title", required: false, description: "Short advisory title (create)" },
		{ name: "detail", required: false, description: "Full description (create)" },
		{ name: "action", required: false, description: "Recommended corrective action (create)" },
		{ name: "impact", required: false, description: "Impact description (create)" },
		{ name: "status", required: false, description: "Filter by status (list)" },
		{ name: "until", required: false, description: "Defer until ISO date (defer)" },
		{ name: "id", required: false, description: "Advisory ID" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const subcommand = args.subcommand;

			// Backward compatibility: if no subcommand but title+detail present, treat as create
			if (!subcommand && args.title) {
				return handleCreate(args, ctx);
			}

			switch (subcommand) {
				case "create":
					return handleCreate(args, ctx);
				case "dismiss":
					return handleDismiss(args, ctx);
				case "approve":
					return handleApprove(args, ctx);
				case "apply":
					return handleApply(args, ctx);
				case "defer":
					return handleDefer(args, ctx);
				case "list":
					return handleList(args, ctx);
				default:
					return commandError(
						"usage: advisory <create|dismiss|approve|apply|defer|list> [args]\n" +
							"  create --title T --detail D [--action A] [--impact I]\n" +
							"  dismiss <id>\n" +
							"  approve <id>\n" +
							"  apply <id>\n" +
							"  defer <id> [--until ISO]\n" +
							"  list [--status S]",
					);
			}
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
