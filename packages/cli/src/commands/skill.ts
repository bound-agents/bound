import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deleteSkill, importSkillFromFiles } from "@bound/agent";
import type { SkillFileEntry } from "@bound/shared";

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
		throw new Error(`Skill '${name}' not found.`);
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
// skillDelete
// ---------------------------------------------------------------------------

export function skillDelete(db: Database, siteId: string, name: string, reason?: string): void {
	const result = deleteSkill(db, siteId, name, { by: "operator", reason });

	if (!result.ok) {
		throw new Error(result.error ?? `Failed to delete skill '${name}'.`);
	}

	const reasonMsg = reason ? ` (reason: ${reason})` : "";
	console.log(`Skill '${name}' deleted${reasonMsg}. ${result.filesDeleted} file(s) removed.`);
	if (result.advisoryCount > 0) {
		console.log(
			`${result.advisoryCount} task(s) reference this skill — advisories filed to update or remove the reference.`,
		);
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

export async function skillImport(
	db: Database,
	siteId: string,
	localPath: string,
	_opts: SkillImportOpts = {},
): Promise<void> {
	// Validate: directory must exist
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(localPath);
	} catch (cause) {
		throw new Error(`Path '${localPath}' does not exist.`, { cause });
	}
	if (!stat.isDirectory()) {
		throw new Error(`'${localPath}' is not a directory.`);
	}

	// Read SKILL.md
	const skillMdPath = join(localPath, "SKILL.md");
	let skillMdContent: string;
	try {
		skillMdContent = readFileSync(skillMdPath, "utf-8");
	} catch (cause) {
		throw new Error(`SKILL.md not found at ${skillMdPath}.`, { cause });
	}

	// Collect all files recursively
	const allFiles = collectFiles(localPath, localPath);

	// Convert to SkillFileEntry[] format, with SKILL.md first
	const files: SkillFileEntry[] = [
		{ path: "SKILL.md", content: skillMdContent },
		...allFiles
			.filter((f) => f.relPath !== "SKILL.md")
			.map((f) => ({ path: f.relPath, content: f.content })),
	];

	// Call shared import service
	const result = await importSkillFromFiles(db, siteId, files, {});

	if (result.ok) {
		console.log(`Skill '${result.name}' imported: ${files.length} file(s) written to files table.`);
	} else {
		throw new Error(result.error);
	}
}
