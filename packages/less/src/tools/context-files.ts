import { isAbsolute, join, resolve } from "node:path";

/**
 * The standard context files that boundless auto-injects when present in the
 * working directory. These are project-level instruction files for agents.
 */
export const CONTEXT_FILE_CANDIDATES = [
	"README.md",
	"CONTRIBUTING.md",
	"AGENTS.md",
	"CLAUDE.md",
] as const;

/**
 * Explains, in the system prompt, why the injected copy of a context file does
 * not change when the agent edits it mid-session. The copy is frozen at session
 * start so the prompt prefix stays cache-stable; re-reading to "verify" an edit
 * landed is wasted work (a churn Opus 4.8 in particular is prone to — issue #172).
 */
export const CONTEXT_FILES_STALENESS_NOTE =
	"These files were read from disk when the session started. The copy shown here is held FROZEN for prompt-cache stability and is NOT refreshed when you edit the file during this session — it keeps showing the file as it was at session start. After you write or edit one of these files, trust the tool result; do not re-read the file just to confirm the change landed.";

/**
 * The steering line appended to a write/edit tool result when the modified file
 * is one of the injected context files. Mirrors CONTEXT_FILES_STALENESS_NOTE so
 * the same information reaches the agent at the moment it edits, not only in the
 * (already-stale) system prompt.
 */
export function contextFileStaleNote(filename: string): string {
	return `Heads up: ${filename} is injected into your system prompt as a context file, and that injected copy is held frozen for prompt-cache stability — it still shows the file as it was at session start, NOT this edit. The change above is already on disk; do not re-read ${filename} to verify it.`;
}

/**
 * Whether `filePath` (absolute, or relative to `cwd`) resolves to one of the
 * configured context files for this session.
 */
export function isContextFile(
	filePath: string,
	cwd: string,
	candidates: readonly string[] = CONTEXT_FILE_CANDIDATES,
): boolean {
	const resolved = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	return candidates.some((candidate) => resolve(cwd, candidate) === resolved);
}

/**
 * Reads context files from the given working directory. Files that are absent
 * or unreadable are silently skipped. Returns a delineated block wrapping each
 * found file in a `<context-file>` node carrying its `path` and last-modified
 * `mtime`, under a `<context-files>` parent whose `note` attribute explains the
 * frozen-copy semantics. Returns an empty string if no files are present.
 *
 * @param cwd - Working directory to search in
 * @param candidates - Files to look for. Defaults to CONTEXT_FILE_CANDIDATES.
 *   Pass a custom list (relative paths) to override the defaults.
 */
export async function collectContextFiles(cwd: string, candidates?: string[]): Promise<string> {
	const nodes: string[] = [];
	const included = new Set<string>();

	for (const filename of candidates ?? CONTEXT_FILE_CANDIDATES) {
		// AGENTS.md is the cross-agent open standard; CLAUDE.md is the
		// Claude-specific fallback (typically just `@AGENTS.md`). When AGENTS.md is
		// present, injecting CLAUDE.md too is redundant duplication on the wire —
		// skip it. AGENTS.md precedes CLAUDE.md in CONTEXT_FILE_CANDIDATES, so it's
		// already been collected here if present-and-non-empty. A custom candidate
		// list that omits AGENTS.md never trips this, so an explicit CLAUDE.md
		// request is still honored.
		if (filename === "CLAUDE.md" && included.has("AGENTS.md")) {
			continue;
		}

		const filepath = join(cwd, filename);
		try {
			const file = Bun.file(filepath);
			const content = await file.text();
			if (content.trim()) {
				const mtime = Number.isFinite(file.lastModified)
					? new Date(file.lastModified).toISOString()
					: "unknown";
				nodes.push(
					`<context-file path="${filename}" mtime="${mtime}">\n${content.trim()}\n</context-file>`,
				);
				included.add(filename);
			}
		} catch {
			// File doesn't exist or can't be read — skip silently
		}
	}

	if (nodes.length === 0) {
		return "";
	}

	return `<context-files note="${CONTEXT_FILES_STALENESS_NOTE}">\n${nodes.join("\n\n")}\n</context-files>`;
}
