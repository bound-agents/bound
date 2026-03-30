import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter } from "@bound/agent/src/commands/skill-activate.js";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

// parseFrontmatter is imported from @bound/agent (packages/agent/src/commands/skill-activate.ts)
// which is already a dependency of @bound/cli. This avoids duplication of the frontmatter
// parser logic between agent and CLI packages.

// ---------------------------------------------------------------------------
// skillList
// ---------------------------------------------------------------------------

export interface SkillListOpts {
	status?: string;
	verbose?: boolean;
}

export function skillList(db: Database, opts: SkillListOpts = {}): void {
	const whereClause = opts.status ? "WHERE status = ? AND deleted = 0" : "WHERE deleted = 0";
	const queryArgs = opts.status ? [opts.status] : [];

	const rows = db
		.prepare(
			`SELECT name, status, activation_count, last_activated_at, description,
			        allowed_tools, compatibility, content_hash, retired_reason,
			        skill_root
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
		skill_root: string;
	}>;

	if (rows.length === 0) {
		const filter = opts.status ? ` (status: ${opts.status})` : "";
		console.log(`No skills found${filter}.`);
		return;
	}

	if (opts.verbose) {
		console.log(
			"NAME             STATUS   ACT  LAST USED            DESCRIPTION                         ALLOWED_TOOLS        HASH             RETIRED_REASON",
		);
		console.log("-".repeat(150));
	} else {
		console.log("NAME             STATUS   ACT  LAST USED            DESCRIPTION");
		console.log("-".repeat(80));
	}

	for (const row of rows) {
		const name = row.name.padEnd(16);
		const status = row.status.padEnd(8);
		const act = String(row.activation_count ?? 0).padEnd(4);
		const lastUsed = (row.last_activated_at?.slice(0, 19) ?? "never").padEnd(20);
		const desc = row.description.slice(0, 35).padEnd(35);

		if (opts.verbose) {
			const tools = (row.allowed_tools ?? "").slice(0, 20).padEnd(20);
			const hash = (row.content_hash ?? "").slice(0, 16).padEnd(16);
			const reason = (row.retired_reason ?? "").slice(0, 20);
			console.log(`${name} ${status} ${act} ${lastUsed} ${desc} ${tools} ${hash} ${reason}`);
		} else {
			console.log(`${name} ${status} ${act} ${lastUsed} ${desc}`);
		}
	}
}

// ---------------------------------------------------------------------------
// skillView
// ---------------------------------------------------------------------------

export function skillView(db: Database, name: string): void {
	const skill = db
		.prepare(
			`SELECT id, name, status, activation_count, last_activated_at, description,
			        content_hash, skill_root, retired_by, retired_reason
			 FROM skills WHERE name = ? AND deleted = 0`,
		)
		.get(name) as {
		id: string;
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
		skill_root: string;
		retired_by: string | null;
		retired_reason: string | null;
	} | null;

	if (!skill) {
		console.error(`Error: Skill '${name}' not found.`);
		process.exit(1);
	}

	// Print metadata header
	console.log(`=== Skill: ${skill.name} ===`);
	console.log(`Status:      ${skill.status}`);
	console.log(`Activations: ${skill.activation_count ?? 0}`);
	console.log(`Last used:   ${skill.last_activated_at?.slice(0, 19) ?? "never"}`);
	console.log(`Hash:        ${skill.content_hash ?? "unknown"}`);
	if (skill.retired_by) {
		console.log(`Retired by:  ${skill.retired_by}`);
		if (skill.retired_reason) {
			console.log(`Reason:      ${skill.retired_reason}`);
		}
	}
	console.log("");

	// Print SKILL.md content from files table
	const skillMdPath = `${skill.skill_root}/SKILL.md`;
	const skillMdRow = db
		.prepare("SELECT content FROM files WHERE path = ? AND deleted = 0")
		.get(skillMdPath) as { content: string } | null;

	if (skillMdRow?.content) {
		console.log("=== SKILL.md ===");
		console.log(skillMdRow.content);
	} else {
		console.log("(SKILL.md content not found in files table)");
	}

	// Print file listing from files table
	const files = db
		.prepare(
			`SELECT path, size_bytes, modified_at FROM files
			 WHERE path LIKE ? AND deleted = 0
			 ORDER BY path`,
		)
		.all(`${skill.skill_root}/%`) as Array<{
		path: string;
		size_bytes: number;
		modified_at: string;
	}>;

	if (files.length > 0) {
		console.log("\n=== Files ===");
		for (const f of files) {
			const relPath = f.path.replace(`${skill.skill_root}/`, "");
			console.log(
				`  ${relPath.padEnd(40)} ${String(f.size_bytes).padStart(8)} bytes  ${f.modified_at.slice(0, 19)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// skillRetire
// ---------------------------------------------------------------------------

export function skillRetire(db: Database, siteId: string, name: string, reason?: string): void {
	const skill = db
		.prepare("SELECT id, status FROM skills WHERE name = ? AND deleted = 0")
		.get(name) as { id: string; status: string } | null;

	if (!skill) {
		console.error(`Error: Skill '${name}' not found.`);
		process.exit(1);
	}

	const now = new Date().toISOString();

	updateRow(
		db,
		"skills",
		skill.id,
		{
			status: "retired",
			retired_by: "operator",
			retired_reason: reason ?? null,
			modified_at: now,
		},
		siteId,
	);

	// Print per-task warnings for tasks referencing this skill
	const tasks = db
		.prepare("SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL")
		.all() as Array<{ id: string; payload: string; thread_id: string | null }>;

	let warned = 0;
	for (const task of tasks) {
		try {
			const payload = JSON.parse(task.payload);
			if (
				typeof payload === "object" &&
				payload !== null &&
				(payload as Record<string, unknown>).skill === name
			) {
				console.warn(
					`Warning: Task ${task.id} references skill '${name}' (payload.skill). Update or remove the skill reference.`,
				);
				warned++;
			}
		} catch {
			// Skip malformed payload
		}
	}

	const reasonMsg = reason ? ` (reason: ${reason})` : "";
	console.log(`Skill '${name}' retired by operator${reasonMsg}.`);
	if (warned > 0) {
		console.log(`${warned} task(s) reference this skill — see warnings above.`);
	}
}

// ---------------------------------------------------------------------------
// skillImport
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files in a directory, returning { relPath, content } pairs.
 */
function collectFiles(
	dirPath: string,
	baseDir: string,
): Array<{ relPath: string; content: string }> {
	const results: Array<{ relPath: string; content: string }> = [];
	const entries = readdirSync(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectFiles(fullPath, baseDir));
		} else if (entry.isFile()) {
			try {
				const content = readFileSync(fullPath, "utf-8");
				results.push({ relPath: relative(baseDir, fullPath), content });
			} catch {
				// Skip unreadable files (binaries, etc.)
			}
		}
	}
	return results;
}

export interface SkillImportOpts {
	force?: boolean;
}

export function skillImport(
	db: Database,
	siteId: string,
	localPath: string,
	_opts: SkillImportOpts = {},
): void {
	// Validate: directory must exist
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(localPath);
	} catch {
		console.error(`Error: Path '${localPath}' does not exist.`);
		process.exit(1);
	}
	if (!stat.isDirectory()) {
		console.error(`Error: '${localPath}' is not a directory.`);
		process.exit(1);
	}

	// Read and validate SKILL.md
	const skillMdPath = join(localPath, "SKILL.md");
	let skillMdContent: string;
	try {
		skillMdContent = readFileSync(skillMdPath, "utf-8");
	} catch {
		console.error(`Error: SKILL.md not found at ${skillMdPath}.`);
		process.exit(1);
	}

	const parsed = parseFrontmatter(skillMdContent);
	if (!parsed) {
		console.error("Error: SKILL.md is missing required YAML frontmatter (---...---).");
		process.exit(1);
	}

	const { data } = parsed;

	if (!data.name) {
		console.error("Error: SKILL.md frontmatter is missing required 'name' field.");
		process.exit(1);
	}

	if (!data.description) {
		console.error("Error: SKILL.md frontmatter is missing required 'description' field.");
		process.exit(1);
	}

	const skillName = data.name;
	const skillRoot = `/home/user/skills/${skillName}`;
	const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
	const now = new Date().toISOString();

	// Write all files to files table
	const allFiles = collectFiles(localPath, localPath);
	for (const { relPath, content } of allFiles) {
		const filePath = `${skillRoot}/${relPath}`;
		const fileSize = Buffer.byteLength(content, "utf8");
		const fileHash = createHash("sha256").update(content).digest("hex");

		const existingFile = db
			.prepare("SELECT id, content FROM files WHERE path = ? AND deleted = 0")
			.get(filePath) as { id: string; content: string | null } | null;

		if (existingFile) {
			const existingHash = createHash("sha256")
				.update(existingFile.content ?? "")
				.digest("hex");
			if (existingHash !== fileHash) {
				updateRow(
					db,
					"files",
					existingFile.id,
					{ content, size_bytes: fileSize, modified_at: now },
					siteId,
				);
			}
		} else {
			insertRow(
				db,
				"files",
				{
					id: filePath,
					path: filePath,
					content,
					is_binary: 0,
					size_bytes: fileSize,
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}
	}

	// Upsert skills row
	const contentHash = createHash("sha256").update(skillMdContent).digest("hex");
	const existingSkill = db
		.prepare("SELECT id, activation_count FROM skills WHERE id = ?")
		.get(skillId) as { id: string; activation_count: number } | null;

	if (existingSkill) {
		updateRow(
			db,
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
				activation_count: (existingSkill.activation_count ?? 0) + 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	} else {
		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skillName,
				description: data.description,
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools: data.allowed_tools ?? null,
				compatibility: data.compatibility ?? null,
				metadata_json: JSON.stringify(data),
				activated_at: now,
				created_by_thread: null,
				activation_count: 1,
				last_activated_at: now,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}

	console.log(`Skill '${skillName}' imported: ${allFiles.length} file(s) written to files table.`);
}
