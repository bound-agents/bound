import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandSuccess, handleCommandError } from "./helpers";

export const skillList: CommandDefinition = {
	name: "skill-list",
	args: [
		{
			name: "status",
			required: false,
			description: "Filter by status: 'active' or 'retired'",
		},
		{
			name: "verbose",
			required: false,
			description: "Show additional columns (allowed_tools, compatibility, content_hash, retired_reason)",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const statusFilter = args.status;
			// Boolean flag convention: present = true, absent = false (consistent with forget's --prefix)
			const verbose = args.verbose !== undefined;

			const whereClause = statusFilter
				? "WHERE status = ? AND deleted = 0"
				: "WHERE deleted = 0";
			const queryArgs = statusFilter ? [statusFilter] : [];

			const rows = ctx.db
				.prepare(
					`SELECT name, status, activation_count, last_activated_at, description,
					        allowed_tools, compatibility, content_hash, retired_reason
					 FROM skills
					 ${whereClause}
					 ORDER BY last_activated_at DESC, name ASC`,
				)
				.all(...queryArgs) as Array<{
				name: string;
				status: string;
				activation_count: number;
				last_activated_at: string | null;
				description: string;
				allowed_tools: string | null;
				compatibility: string | null;
				content_hash: string | null;
				retired_reason: string | null;
			}>;

			if (rows.length === 0) {
				const filter = statusFilter ? ` (status: ${statusFilter})` : "";
				return commandSuccess(`No skills found${filter}.\n`);
			}

			const lines: string[] = [];

			// Header
			if (verbose) {
				lines.push(
					"NAME             STATUS   ACTIVATIONS LAST USED            DESCRIPTION                     ALLOWED_TOOLS        CONTENT_HASH     RETIRED_REASON",
				);
				lines.push("-".repeat(160));
			} else {
				lines.push(
					"NAME             STATUS   ACTIVATIONS LAST USED            DESCRIPTION",
				);
				lines.push("-".repeat(90));
			}

			for (const row of rows) {
				const name = row.name.padEnd(16);
				const status = row.status.padEnd(8);
				const activations = String(row.activation_count ?? 0).padEnd(11);
				const lastUsed = (row.last_activated_at?.slice(0, 19) ?? "never").padEnd(20);
				const desc = row.description.slice(0, 33).padEnd(33);

				if (verbose) {
					const tools = (row.allowed_tools ?? "").slice(0, 20).padEnd(20);
					const hash = (row.content_hash ?? "").slice(0, 16).padEnd(16);
					const reason = (row.retired_reason ?? "").slice(0, 20);
					lines.push(
						`${name} ${status} ${activations} ${lastUsed} ${desc} ${tools} ${hash} ${reason}`,
					);
				} else {
					lines.push(`${name} ${status} ${activations} ${lastUsed} ${desc}`);
				}
			}

			return commandSuccess(lines.join("\n") + "\n");
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
