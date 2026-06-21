import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ImportSkillOptions, ImportSkillResult, SkillFileEntry } from "@bound/shared";

/**
 * Explains, in the system prompt, what the pinned-skill block is and why the
 * copy shown there does not change the instant a skill's source is edited. The
 * bodies are read from the skill store when the context is (re)assembled and
 * held FROZEN behind the system-level cache breakpoint for prompt-cache
 * stability — mirroring the context-file staleness handling from issue #172 so
 * verification-obsessive models don't re-read after every edit. Issue #173.
 */
export const SKILL_PIN_STALENESS_NOTE =
	"These are the SKILL.md instruction sets you activated in this thread, pinned here so they stay in context after the aggressive context-slicing that supports unlimited conversation length. Each copy is read from the skill store at context-assembly time and held FROZEN for prompt-cache stability — it is NOT refreshed mid-turn if the skill's source changes. Call the `skill` tool with action `deactivate` to drop a skill from this block once you no longer need it; call action `read` to see a skill's current on-disk content.";

/**
 * Observe which skills are currently activated-and-not-deactivated in a thread
 * by replaying the thread's `skill` tool calls in causal order. A skill enters
 * the pinned set on `activate` and leaves it on `deactivate`; the last action
 * per skill name wins. `retire` is intentionally NOT treated as a deactivate
 * here — the global `status = 'active'` filter in `collectThreadPinnedSkills`
 * already drops retired skills, and a skill can be retired then re-activated.
 *
 * This is the "observe all activated skills in each thread" half of issue #173:
 * per-thread pin membership is derived from the message log, so no new synced
 * table is required and `deactivate` is a pure log signal (it mutates no row).
 *
 * Returns names in first-activation order (stable for byte-stable rendering).
 */
export function observeThreadActivatedSkills(db: Database, threadId: string): string[] {
	const rows = db
		.prepare(
			"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_call' AND deleted = 0 ORDER BY created_at ASC, rowid ASC",
		)
		.all(threadId) as Array<{ content: string }>;

	const lastAction = new Map<string, "activate" | "deactivate">();
	const firstSeenOrder: string[] = [];

	for (const row of rows) {
		let blocks: unknown;
		try {
			blocks = JSON.parse(row.content);
		} catch {
			continue;
		}
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks) {
			if (
				typeof block !== "object" ||
				block === null ||
				(block as { type?: unknown }).type !== "tool_use" ||
				(block as { name?: unknown }).name !== "skill"
			) {
				continue;
			}
			const input = (block as { input?: unknown }).input;
			if (typeof input !== "object" || input === null) continue;
			const action = (input as { action?: unknown }).action;
			const name = (input as { name?: unknown }).name;
			if (typeof name !== "string") continue;
			if (action === "activate") {
				if (!lastAction.has(name)) firstSeenOrder.push(name);
				lastAction.set(name, "activate");
			} else if (action === "deactivate") {
				lastAction.set(name, "deactivate");
			}
		}
	}

	return firstSeenOrder.filter((name) => lastAction.get(name) === "activate");
}

/** A resolved skill body ready to be wrapped into the pinned-skill block. */
export interface PinnedSkill {
	name: string;
	body: string;
	/** ISO timestamp of the pinned copy's source, surfaced as an XML attribute. */
	mtime: string;
}

/**
 * Render the pinned-skill block: each body wrapped in a `<skill>` node carrying
 * its `name` and `mtime`, under a `<pinned-skills>` parent whose `note`
 * attribute explains the frozen-copy semantics (issue #173, mirroring the
 * `<context-files>` shape from #172). Returns an empty string when there is
 * nothing to pin.
 */
export function renderPinnedSkillsBlock(skills: ReadonlyArray<PinnedSkill>): string {
	if (skills.length === 0) return "";
	const nodes = skills.map(
		(s) => `<skill name="${s.name}" mtime="${s.mtime}">\n${s.body.trim()}\n</skill>`,
	);
	return `<pinned-skills note="${SKILL_PIN_STALENESS_NOTE}">\n${nodes.join("\n\n")}\n</pinned-skills>`;
}

/** Result of resolving a thread's pinned skills for injection into the prompt. */
export interface ThreadPinnedSkills {
	/** Rendered `<pinned-skills>` block, or "" when nothing is pinned. */
	block: string;
	/**
	 * Determinant of the pinned set (sorted `name:content_hash` digest), or ""
	 * when nothing is pinned. Folded into `stablePrefixInputFingerprint` so a
	 * `deactivate` — which writes no stable-side row — shifts the input
	 * fingerprint and is classified as benign `collect` drift rather than a
	 * spurious `compose` leak. See run-stable-prefix-drift-validation.ts.
	 */
	fingerprint: string;
	/** Names actually pinned (globally active, content present), in render order. */
	pinnedNames: string[];
}

/**
 * Resolve the thread's activated-and-not-deactivated skills to their current
 * SKILL.md bodies and render the pinned-skill block. Skills that have since
 * been retired (or whose body is missing) are dropped. `excludeName` skips a
 * skill already injected through another channel (the task-referenced skill
 * body) to avoid duplicating it.
 */
export function collectThreadPinnedSkills(
	db: Database,
	threadId: string,
	excludeName?: string,
): ThreadPinnedSkills {
	const names = observeThreadActivatedSkills(db, threadId).filter((n) => n !== excludeName);
	const resolved: PinnedSkill[] = [];
	const determinantParts: string[] = [];

	for (const name of names) {
		const skill = db
			.prepare(
				"SELECT skill_root, content_hash, modified_at FROM skills WHERE name = ? AND status = 'active' AND deleted = 0",
			)
			.get(name) as {
			skill_root: string | null;
			content_hash: string | null;
			modified_at: string | null;
		} | null;
		if (!skill) continue; // retired, deleted, or never existed — don't pin

		const skillMdPath = skill.skill_root
			? `${skill.skill_root}/SKILL.md`
			: `skills/${name}/SKILL.md`;
		const fileRow = db
			.prepare("SELECT content, modified_at FROM files WHERE path = ? AND deleted = 0")
			.get(skillMdPath) as { content: string | null; modified_at: string | null } | null;
		if (!fileRow?.content) continue;

		const mtime = fileRow.modified_at ?? skill.modified_at ?? "unknown";
		resolved.push({ name, body: fileRow.content, mtime });
		determinantParts.push(`${name}:${skill.content_hash ?? ""}`);
	}

	if (resolved.length === 0) {
		return { block: "", fingerprint: "", pinnedNames: [] };
	}

	const fingerprint = createHash("sha256")
		.update(determinantParts.slice().sort().join("|"))
		.digest("hex")
		.slice(0, 16);

	return {
		block: renderPinnedSkillsBlock(resolved),
		fingerprint,
		pinnedNames: resolved.map((s) => s.name),
	};
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Shared utility for both native skill tool and any other code that needs to parse skill frontmatter.
 */
export function parseFrontmatter(
	content: string,
): { data: Record<string, string>; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) return null;
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			data[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
		}
	}
	return { data, body: match[2] ?? "" };
}

// Validation constants
export const MAX_ACTIVE_SKILLS = 20;
export const MAX_SKILL_BODY_LINES = 500;
export const MAX_FILE_SIZE_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Import and persist a skill from a file entry list.
 * Validates name, description, body, and file sizes.
 * Handles both new skill creation and re-activation of retired skills.
 */
export async function importSkillFromFiles(
	db: Database,
	siteId: string,
	files: SkillFileEntry[],
	options: ImportSkillOptions,
): Promise<ImportSkillResult> {
	try {
		// Step 1: Locate SKILL.md
		const skillMdEntry = files.find((f) => f.path === "SKILL.md");
		if (!skillMdEntry) {
			return { ok: false, error: "SKILL.md not found in file list" };
		}

		// Step 2: Parse frontmatter
		const parsed = parseFrontmatter(skillMdEntry.content);
		if (!parsed) {
			return { ok: false, error: "Invalid frontmatter in SKILL.md" };
		}

		const { data, body } = parsed;

		// Step 3: Validate name
		const name = data.name?.trim();
		if (!name) {
			return { ok: false, error: "Skill name is required" };
		}
		if (!SKILL_NAME_REGEX.test(name)) {
			return {
				ok: false,
				error: `Invalid skill name format. Must match pattern ${SKILL_NAME_REGEX.source}`,
			};
		}
		if (name.length > MAX_SKILL_NAME_LENGTH) {
			return {
				ok: false,
				error: `Skill name must be ≤ ${MAX_SKILL_NAME_LENGTH} characters`,
			};
		}

		// Step 4: Validate description
		const description = data.description?.trim();
		if (!description) {
			return { ok: false, error: "Skill description is required" };
		}
		if (description.length > MAX_DESCRIPTION_LENGTH) {
			return {
				ok: false,
				error: `Description must be ≤ ${MAX_DESCRIPTION_LENGTH} characters`,
			};
		}

		// Step 5: Validate body
		const bodyLines = body.split(/\r?\n/).length;
		if (bodyLines > MAX_SKILL_BODY_LINES) {
			return {
				ok: false,
				error: `Skill body must be ≤ ${MAX_SKILL_BODY_LINES} lines`,
			};
		}

		// Step 6: Validate total size
		const totalSize = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
		if (totalSize > MAX_FILE_SIZE_BYTES) {
			return {
				ok: false,
				error: `Total file size must be ≤ ${MAX_FILE_SIZE_BYTES} bytes`,
			};
		}

		// Step 7: Check active skill cap
		const activeCount = db
			.prepare("SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0")
			.get() as { count: number };

		const skillId = deterministicUUID(BOUND_NAMESPACE, name);
		const existingSkill = db
			.prepare("SELECT * FROM skills WHERE id = ? AND deleted = 0")
			.get(skillId) as Record<string, unknown> | null;

		if (activeCount.count >= MAX_ACTIVE_SKILLS && !existingSkill) {
			return {
				ok: false,
				error: `Active skill cap (${MAX_ACTIVE_SKILLS}) reached. Retire a skill before creating a new one.`,
			};
		}

		// Step 8: Compute deterministic UUID (already done above)
		// Step 9: Compute content_hash
		const contentHash = createHash("sha256").update(skillMdEntry.content).digest("hex");

		// Step 10: Check existing skill
		const now = new Date().toISOString();

		// Preserve an existing skill's skill_root so re-activation / content updates
		// don't migrate its files to a new location (orphaning the originals and
		// breaking the next activation). Two conventions exist in the wild —
		// `skills/<name>` (the documented default) and `/home/user/skills/<name>`
		// (what fresh native-tool imports have historically written). New skills
		// default to the latter, matching where handleActivate collects VFS files.
		const skillRoot =
			(existingSkill?.skill_root as string | null | undefined) ?? `/home/user/skills/${name}`;

		if (existingSkill) {
			const existingAsSkill = existingSkill as Record<string, unknown> & {
				status: string;
				activation_count: number;
			};
			if (existingAsSkill.status === "retired") {
				// Re-activation
				updateRow(
					db,
					"skills",
					skillId,
					{
						status: "active",
						content_hash: contentHash,
						skill_root: skillRoot,
						activation_count: existingAsSkill.activation_count + 1,
						last_activated_at: now,
						activated_at: now,
						modified_at: now,
						description,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						metadata_json: JSON.stringify(data),
						retired_by: null,
						retired_reason: null,
					},
					siteId,
				);
			} else {
				// Content update (already active)
				updateRow(
					db,
					"skills",
					skillId,
					{
						content_hash: contentHash,
						skill_root: skillRoot,
						modified_at: now,
						description,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						metadata_json: JSON.stringify(data),
						activation_count: existingAsSkill.activation_count + 1,
						last_activated_at: now,
					},
					siteId,
				);
			}
		} else {
			// New skill creation
			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name,
					description,
					status: "active",
					skill_root: skillRoot,
					content_hash: contentHash,
					allowed_tools: data.allowed_tools ?? null,
					compatibility: data.compatibility ?? null,
					metadata_json: JSON.stringify(data),
					activated_at: now,
					created_by_thread: options.threadId ?? null,
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

		// Step 11: Persist files
		for (const entry of files) {
			const filePath = `${skillRoot}/${entry.path}`;
			const fileId = filePath;
			const sizeBytes = Buffer.byteLength(entry.content, "utf8");

			const existingFile = db
				.prepare("SELECT id FROM files WHERE id = ? AND deleted = 0")
				.get(fileId) as Record<string, unknown> | null;

			if (existingFile) {
				updateRow(
					db,
					"files",
					fileId,
					{
						content: entry.content,
						size_bytes: sizeBytes,
						modified_at: now,
					},
					siteId,
				);
			} else {
				insertRow(
					db,
					"files",
					{
						id: fileId,
						path: filePath,
						content: entry.content,
						is_binary: 0,
						size_bytes: sizeBytes,
						created_at: now,
						modified_at: now,
						deleted: 0,
						created_by: options.threadId ?? null,
						host_origin: null,
					},
					siteId,
				);
			}
		}

		// Step 12: Return success
		return { ok: true, skillId, name };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to import skill: ${message}` };
	}
}
