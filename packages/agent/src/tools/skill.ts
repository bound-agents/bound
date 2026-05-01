import { createHash, randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { RegisteredTool, ToolContext } from "../types";
import { parseFrontmatter } from "./skill-utils";

const MAX_ACTIVE_SKILLS = 20;
const MAX_SKILL_BODY_LINES = 500;
const MAX_FILE_SIZE_BYTES = 64 * 1024; // 64 KB
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;

export function createSkillTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "skill",
				description: "Manage skills: activate, list, read, or retire",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["activate", "list", "read", "retire"],
							description: "Skill operation to perform",
						},
						name: {
							type: "string",
							description: "Skill name (for activate, read, retire)",
						},
						status: {
							type: "string",
							enum: ["active", "retired"],
							description: "Filter by status (for list)",
						},
						verbose: {
							type: "boolean",
							description: "Show extra columns (for list)",
						},
						reason: {
							type: "string",
							description: "Reason for retiring (for retire)",
						},
					},
					required: ["action"],
					additionalProperties: false,
				},
			},
		},
		execute: async (input: Record<string, unknown>): Promise<string> => {
			try {
				const action = input.action as string;

				if (!action) {
					return `Error: 'action' is required. Valid actions: activate, list, read, retire`;
				}

				switch (action) {
					case "activate":
						return await handleActivate(ctx, input);
					case "list":
						return await handleList(ctx, input);
					case "read":
						return await handleRead(ctx, input);
					case "retire":
						return await handleRetire(ctx, input);
					default:
						return `Error: Invalid action '${action}'. Valid actions: activate, list, read, retire`;
				}
			} catch (error) {
				return `Error: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	};
}

async function handleActivate(ctx: ToolContext, input: Record<string, unknown>): Promise<string> {
	if (!ctx.fs) {
		return "Error: Filesystem unavailable: ctx.fs is not set";
	}

	const name = input.name as string | undefined;
	if (!name) {
		return "Error: 'name' is required for activate action";
	}

	const skillRoot = `/home/user/skills/${name}`;
	const skillMdPath = `${skillRoot}/SKILL.md`;

	// Validate skill name format
	if (!SKILL_NAME_REGEX.test(name)) {
		return `Error: Invalid skill name '${name}': must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric, hyphens allowed between segments)`;
	}
	if (name.length > MAX_SKILL_NAME_LENGTH) {
		return `Error: Skill name '${name}' exceeds maximum length of ${MAX_SKILL_NAME_LENGTH} characters`;
	}

	// Read SKILL.md
	let content: string;
	try {
		content = await ctx.fs.readFile(skillMdPath);
	} catch {
		return `Error: Skill '${name}' not found: missing ${skillMdPath}`;
	}

	// Validate file size
	const sizeBytes = Buffer.byteLength(content, "utf8");
	if (sizeBytes > MAX_FILE_SIZE_BYTES) {
		return `Error: SKILL.md exceeds 64 KB size limit (${sizeBytes} bytes)`;
	}

	// Parse frontmatter
	const parsed = parseFrontmatter(content);
	if (!parsed) {
		return "Error: SKILL.md is missing required YAML frontmatter (---...---)";
	}

	const { data, body } = parsed;

	// Validate name matches directory
	if (data.name && data.name !== name) {
		return `Error: Frontmatter 'name' field ('${data.name}') does not match directory name ('${name}')`;
	}

	// Validate description is present and within length limit
	if (!data.description) {
		return "Error: SKILL.md is missing required 'description' field in frontmatter";
	}
	if (data.description.length > MAX_DESCRIPTION_LENGTH) {
		return `Error: Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${data.description.length} chars)`;
	}

	// Validate body line count
	const bodyLines = body.split("\n").length;
	if (bodyLines > MAX_SKILL_BODY_LINES) {
		return `Error: SKILL.md body exceeds ${MAX_SKILL_BODY_LINES} lines (${bodyLines} lines)`;
	}

	// Check active skill cap — do not count the skill being (re-)activated itself
	const skillId = deterministicUUID(BOUND_NAMESPACE, name);
	const capRow = ctx.db
		.prepare(
			"SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0 AND id != ?",
		)
		.get(skillId) as { count: number };
	if (capRow.count >= MAX_ACTIVE_SKILLS) {
		return `Error: Active skill cap reached (${MAX_ACTIVE_SKILLS} maximum). Retire a skill before activating another.`;
	}

	const now = new Date().toISOString();

	// Early file persistence — write all skill files to files table BEFORE upserting skills row
	const allPaths = ctx.fs.getAllPaths().filter((p) => p.startsWith(`${skillRoot}/`));
	for (const filePath of allPaths) {
		let fileContent: string;
		try {
			fileContent = await ctx.fs.readFile(filePath);
		} catch {
			continue; // skip unreadable entries (e.g., directories)
		}
		const fileSize = Buffer.byteLength(fileContent, "utf8");
		const fileHash = createHash("sha256").update(fileContent).digest("hex");

		const existingFile = ctx.db
			.prepare("SELECT id, content FROM files WHERE path = ? AND deleted = 0")
			.get(filePath) as { id: string; content: string } | null;

		if (existingFile) {
			const existingHash = createHash("sha256")
				.update(existingFile.content ?? "")
				.digest("hex");
			if (existingHash !== fileHash) {
				updateRow(
					ctx.db,
					"files",
					existingFile.id,
					{ content: fileContent, size_bytes: fileSize, modified_at: now },
					ctx.siteId,
				);
			}
		} else {
			insertRow(
				ctx.db,
				"files",
				{
					id: filePath,
					path: filePath,
					content: fileContent,
					is_binary: 0,
					size_bytes: fileSize,
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				ctx.siteId,
			);
		}
	}

	// Upsert skills row — after files are persisted
	const contentHash = createHash("sha256").update(content).digest("hex");
	const existing = ctx.db
		.prepare("SELECT id, activation_count FROM skills WHERE id = ?")
		.get(skillId) as { id: string; activation_count: number } | null;

	if (existing) {
		updateRow(
			ctx.db,
			"skills",
			skillId,
			{
				description: data.description,
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools: data.allowed_tools ?? null,
				compatibility: data.compatibility ?? null,
				metadata_json: JSON.stringify(data),
				activated_at: now,
				activation_count: (existing.activation_count ?? 0) + 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);
	} else {
		insertRow(
			ctx.db,
			"skills",
			{
				id: skillId,
				name,
				description: data.description,
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools: data.allowed_tools ?? null,
				compatibility: data.compatibility ?? null,
				metadata_json: JSON.stringify(data),
				activated_at: now,
				created_by_thread: ctx.threadId ?? null,
				activation_count: 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			ctx.siteId,
		);
	}

	return `Skill '${name}' activated successfully.`;
}

async function handleList(ctx: ToolContext, input: Record<string, unknown>): Promise<string> {
	const statusFilter = input.status as string | undefined;
	const verbose = input.verbose === true;

	const whereClause = statusFilter ? "WHERE status = ? AND deleted = 0" : "WHERE deleted = 0";
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
		return `No skills found${filter}.`;
	}

	const lines: string[] = [];

	// Header
	if (verbose) {
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

		if (verbose) {
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

async function handleRead(ctx: ToolContext, input: Record<string, unknown>): Promise<string> {
	const name = input.name as string | undefined;
	if (!name) {
		return "Error: 'name' is required for read action";
	}

	const skillMdPath = `/home/user/skills/${name}/SKILL.md`;

	// Get skill metadata
	const skill = ctx.db
		.prepare(
			"SELECT id, name, status, activation_count, last_activated_at, description, content_hash FROM skills WHERE name = ? AND deleted = 0",
		)
		.get(name) as {
		id: string;
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
	} | null;

	if (!skill) {
		return `Error: Skill '${name}' not found.`;
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

async function handleRetire(ctx: ToolContext, input: Record<string, unknown>): Promise<string> {
	const name = input.name as string | undefined;
	if (!name) {
		return "Error: 'name' is required for retire action";
	}

	const reason = (input.reason as string | undefined) ?? null;

	// Find the skill
	const skill = ctx.db
		.prepare("SELECT id, status FROM skills WHERE name = ? AND deleted = 0")
		.get(name) as { id: string; status: string } | null;

	if (!skill) {
		return `Error: Skill '${name}' not found.`;
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
			(payload as Record<string, unknown>).skill === name
		) {
			const advisoryId = randomUUID();
			insertRow(
				ctx.db,
				"advisories",
				{
					id: advisoryId,
					type: "general",
					status: "proposed",
					title: `Skill '${name}' was retired`,
					detail: `Task ${task.id} references skill '${name}' which was retired by agent${reason ? `: ${reason}` : ""}.`,
					action: `Update task ${task.id} to use a different skill or remove the skill reference.`,
					impact: null,
					evidence: JSON.stringify({ task_id: task.id, skill: name }),
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

	const msg = reason ? `Skill '${name}' retired. Reason: ${reason}.` : `Skill '${name}' retired.`;
	const advisoryMsg =
		advisoryCount > 0
			? ` ${advisoryCount} advisory${advisoryCount === 1 ? "" : "s"} created for referencing tasks.`
			: "";
	return msg + advisoryMsg;
}
