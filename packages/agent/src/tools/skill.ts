import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { SkillFileEntry } from "@bound/shared";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { MAX_SKILL_NAME_LENGTH, SKILL_NAME_REGEX, importSkillFromFiles } from "./skill-utils.js";
import { parseToolInput, zodToToolParams } from "./tool-schema";

const skillSchema = z.object({
	action: z.enum(["activate", "list", "read", "retire"]).describe("Skill operation to perform"),
	name: z.string().optional().describe("Skill name (for activate, read, retire)"),
	status: z.enum(["active", "retired"]).optional().describe("Filter by status (for list)"),
	verbose: z.boolean().optional().describe("Show extra columns (for list)"),
	reason: z.string().optional().describe("Reason for retiring (for retire)"),
});

export function createSkillTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(skillSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "skill",
				description: "Manage skills: activate, list, read, or retire",
				parameters: jsonSchema,
			},
		},
		// Per-action idempotency. list/read are pure queries. activate/retire
		// flip a status flag — running them twice with the same skill name
		// leaves the same final state.
		resolveAnnotations: (args: Record<string, unknown>) => {
			switch (args.action) {
				case "list":
				case "read":
					return { idempotent: true, readOnly: true };
				case "activate":
				case "retire":
					return { idempotent: true, readOnly: false };
				default:
					return {};
			}
		},
		execute: async (raw: Record<string, unknown>): Promise<string> => {
			const parsed = parseToolInput(skillSchema, raw, "skill");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				switch (input.action) {
					case "activate":
						return await handleActivate(ctx, input);
					case "list":
						return await handleList(ctx, input);
					case "read":
						return await handleRead(ctx, input);
					case "retire":
						return await handleRetire(ctx, input);
					default:
						return `Error: Invalid action '${input.action}'. Valid actions: activate, list, read, retire`;
				}
			} catch (error) {
				return `Error: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	};
}

async function handleActivate(
	ctx: ToolContext,
	input: z.infer<typeof skillSchema>,
): Promise<string> {
	if (!ctx.fs) {
		return "Error: Filesystem unavailable: ctx.fs is not set";
	}

	if (!input.name) {
		return "Error: 'name' is required for activate action";
	}

	// Early name validation — to maintain consistent error message order with tests
	// (The shared service will re-validate, but tests expect this check first)
	if (!SKILL_NAME_REGEX.test(input.name)) {
		return `Error: Invalid skill name '${input.name}': must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric, hyphens allowed between segments)`;
	}
	if (input.name.length > MAX_SKILL_NAME_LENGTH) {
		return `Error: Skill name '${input.name}' exceeds maximum length of ${MAX_SKILL_NAME_LENGTH} characters`;
	}

	const skillRoot = `/home/user/skills/${input.name}`;

	// Collect all files from VFS under skillRoot
	const allPaths = ctx.fs.getAllPaths().filter((p) => p.startsWith(`${skillRoot}/`));
	const files: SkillFileEntry[] = [];

	for (const filePath of allPaths) {
		let content: string;
		try {
			content = await ctx.fs.readFile(filePath);
		} catch {
			continue; // skip unreadable entries (e.g., directories)
		}
		const relativePath = filePath.slice(skillRoot.length + 1); // strip "skills/name/" prefix
		files.push({ path: relativePath, content });
	}

	// Call shared import service
	const result = await importSkillFromFiles(ctx.db, ctx.siteId, files, {
		threadId: ctx.threadId,
	});

	if (result.ok) {
		return `Skill '${result.name}' activated successfully.`;
	}
	return `Error: ${result.error}`;
}

async function handleList(ctx: ToolContext, input: z.infer<typeof skillSchema>): Promise<string> {
	const whereClause = input.status ? "WHERE status = ? AND deleted = 0" : "WHERE deleted = 0";
	const queryArgs = input.status ? [input.status] : [];

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
		const filter = input.status ? ` (status: ${input.status})` : "";
		return `No skills found${filter}.`;
	}

	const lines: string[] = [];

	// Header
	if (input.verbose) {
		lines.push(
			"NAME             STATUS   ACTIVATIONS LAST USED            DESCRIPTION                     ALLOWED_TOOLS        COMPATIBILITY   CONTENT_HASH     RETIRED_REASON",
		);
		lines.push("-".repeat(160));
	} else {
		lines.push("NAME             STATUS   ACTIVATIONS LAST USED            DESCRIPTION");
		lines.push("-".repeat(90));
	}

	for (const row of rows) {
		const name = row.name.padEnd(16);
		const status = row.status.padEnd(8);
		const activations = String(row.activation_count ?? 0).padEnd(11);
		const lastUsed = (row.last_activated_at?.slice(0, 19) ?? "never").padEnd(20);
		const desc = row.description.slice(0, 33).padEnd(33);

		if (input.verbose) {
			const tools = (row.allowed_tools ?? "").slice(0, 20).padEnd(20);
			const compatibility = (row.compatibility ?? "").slice(0, 15).padEnd(15);
			const hash = (row.content_hash ?? "").slice(0, 16).padEnd(16);
			const reason = (row.retired_reason ?? "").slice(0, 20);
			lines.push(
				`${name} ${status} ${activations} ${lastUsed} ${desc} ${tools} ${compatibility} ${hash} ${reason}`,
			);
		} else {
			lines.push(`${name} ${status} ${activations} ${lastUsed} ${desc}`);
		}
	}

	return lines.join("\n");
}

async function handleRead(ctx: ToolContext, input: z.infer<typeof skillSchema>): Promise<string> {
	if (!input.name) {
		return "Error: 'name' is required for read action";
	}

	const skillMdPath = `/home/user/skills/${input.name}/SKILL.md`;

	// Get skill metadata
	const skill = ctx.db
		.prepare(
			"SELECT id, name, status, activation_count, last_activated_at, description, content_hash FROM skills WHERE name = ? AND deleted = 0",
		)
		.get(input.name) as {
		id: string;
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
	} | null;

	if (!skill) {
		return `Error: Skill '${input.name}' not found.`;
	}

	// Read SKILL.md content from files table
	const fileRow = ctx.db
		.prepare("SELECT content FROM files WHERE path = ? AND deleted = 0")
		.get(skillMdPath) as { content: string } | null;

	const skillMdContent = fileRow?.content ?? "(SKILL.md content not found in files table)";

	const header = [
		`--- Skill: ${skill.name} ---`,
		`Status:      ${skill.status}`,
		`Activations: ${skill.activation_count ?? 0}`,
		`Last used:   ${skill.last_activated_at?.slice(0, 19) ?? "never"}`,
		`Hash:        ${skill.content_hash ?? "unknown"}`,
		"",
	].join("\n");

	return `${header}${skillMdContent}`;
}

async function handleRetire(ctx: ToolContext, input: z.infer<typeof skillSchema>): Promise<string> {
	if (!input.name) {
		return "Error: 'name' is required for retire action";
	}

	const reason = input.reason ?? null;

	// Find the skill
	const skill = ctx.db
		.prepare("SELECT id, status FROM skills WHERE name = ? AND deleted = 0")
		.get(input.name) as { id: string; status: string } | null;

	if (!skill) {
		return `Error: Skill '${input.name}' not found.`;
	}

	const now = new Date().toISOString();

	// Retire the skill
	updateRow(
		ctx.db,
		"skills",
		skill.id,
		{
			status: "retired",
			retired_by: "agent",
			retired_reason: reason,
			modified_at: now,
		},
		ctx.siteId,
	);

	// Scan tasks for payloads referencing this skill and create advisories
	const tasks = ctx.db
		.prepare("SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL")
		.all() as Array<{ id: string; payload: string; thread_id: string | null }>;

	let advisoryCount = 0;
	for (const task of tasks) {
		let payload: unknown;
		try {
			payload = JSON.parse(task.payload);
		} catch {
			continue;
		}
		if (
			typeof payload === "object" &&
			payload !== null &&
			"skill" in payload &&
			(payload as Record<string, unknown>).skill === input.name
		) {
			const advisoryId = randomUUID();
			insertRow(
				ctx.db,
				"advisories",
				{
					id: advisoryId,
					type: "general",
					status: "proposed",
					title: `Skill '${input.name}' was retired`,
					detail: `Task ${task.id} references skill '${input.name}' which was retired by agent${reason ? `: ${reason}` : ""}.`,
					action: `Update task ${task.id} to use a different skill or remove the skill reference.`,
					impact: null,
					evidence: JSON.stringify({ task_id: task.id, skill: input.name }),
					proposed_at: now,
					defer_until: null,
					resolved_at: null,
					created_by: ctx.siteId,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);
			advisoryCount++;
		}
	}

	const msg = reason
		? `Skill '${input.name}' retired. Reason: ${reason}.`
		: `Skill '${input.name}' retired.`;
	const advisoryMsg =
		advisoryCount > 0
			? ` ${advisoryCount} advisory${advisoryCount === 1 ? "" : "s"} created for referencing tasks.`
			: "";
	return msg + advisoryMsg;
}
