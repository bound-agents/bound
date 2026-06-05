/**
 * Shared content-search core.
 *
 * Both surface tools — `boundless_search` (host, real filesystem) and the sandbox
 * `search` command (VFS via `IFileSystem`) — feed `{ path, content }` pairs into
 * this module. Each surface owns only its file *enumeration*; the matcher, the
 * bounded-preview contract, and the output format live here so the two cannot
 * diverge (the failure mode that bit us when the host shelled out to system grep
 * while the sandbox used just-bash's own regex engine).
 *
 * Matching is line-oriented (grep semantics): the pattern is tested against each
 * line independently, so it never spans a newline. Previews are windowed so a
 * match inside a minified single-line asset yields a bounded slice, never the
 * whole multi-megabyte line.
 */

export const DEFAULT_MAX_MATCHES = 200;
export const DEFAULT_MAX_MATCHES_PER_FILE = 50;
export const DEFAULT_MAX_PREVIEW_CHARS = 200;

/** Default directory segments and binary extensions skipped by `shouldSearchPath`. */
export const DEFAULT_SEARCH_EXCLUDES: readonly string[] = [
	".git/",
	"node_modules/",
	"dist/",
	"build/",
	".next/",
	".svelte-kit/",
	"coverage/",
];

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	// images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"bmp",
	"ico",
	"tiff",
	// fonts
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	// archives / compiled
	"zip",
	"gz",
	"tar",
	"bz2",
	"xz",
	"7z",
	"rar",
	"wasm",
	"o",
	"a",
	"so",
	"dylib",
	"dll",
	"exe",
	"class",
	// media
	"mp3",
	"mp4",
	"mov",
	"avi",
	"mkv",
	"webm",
	"wav",
	"flac",
	"ogg",
	// docs / misc binary
	"pdf",
	"bin",
	"dat",
]);

export interface SearchFileInput {
	path: string;
	content: string;
}

export interface SearchMatch {
	path: string;
	/** 1-based line number of the match. */
	line: number;
	/** 1-based column where the match begins on that line. */
	column: number;
	/** Bounded preview of the matching line. */
	preview: string;
}

export interface SearchOptions {
	/** Regex source (or literal string when `fixedStrings` is set). */
	pattern: string;
	/** Regex flags. `g` is forced on internally; pass e.g. `i` for case-insensitive. */
	flags?: string;
	/** Treat `pattern` as a literal string rather than a regex. */
	fixedStrings?: boolean;
	/** Cap on total matches across all files before truncating. */
	maxMatches?: number;
	/** Cap on matches reported per file. */
	maxMatchesPerFile?: number;
	/** Per-line preview cap; longer lines are windowed around the match. */
	maxPreviewChars?: number;
}

export interface SearchResult {
	matches: SearchMatch[];
	/** True if the `maxMatches` cap was hit (more matches exist than were reported). */
	truncated: boolean;
	filesSearched: number;
	filesMatched: number;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(literal: string): string {
	return literal.replace(REGEX_META, "\\$&");
}

/**
 * Compile a search pattern into a global RegExp. Throws a clean Error on an
 * invalid pattern so callers can surface a usable message rather than a raw
 * SyntaxError stack.
 */
export function compileSearchPattern(options: SearchOptions): RegExp {
	const source = options.fixedStrings ? escapeRegex(options.pattern) : options.pattern;
	const flagSet = new Set((options.flags ?? "").split(""));
	flagSet.add("g"); // global is required for exec() iteration
	flagSet.delete(""); // empty-string artifact from split("")
	const flags = [...flagSet].join("");
	try {
		return new RegExp(source, flags);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid search pattern: ${message}`);
	}
}

/**
 * Build a bounded preview of a matching line. Short lines pass through whole;
 * long lines are windowed around the match with ellipsis markers on truncated
 * ends, so the preview stays close to `maxChars` regardless of line length.
 */
function buildPreview(
	line: string,
	matchStart: number,
	matchEnd: number,
	maxChars: number,
): string {
	if (line.length <= maxChars) {
		return line;
	}
	const matchLen = matchEnd - matchStart;
	const context = Math.max(0, maxChars - matchLen);
	let start = Math.max(0, matchStart - Math.floor(context / 2));
	const end = Math.min(line.length, start + maxChars);
	// If we bumped against the end, pull the window back to keep it full-width.
	start = Math.max(0, end - maxChars);
	let preview = line.slice(start, end);
	if (start > 0) preview = `…${preview}`;
	if (end < line.length) preview = `${preview}…`;
	return preview;
}

/** Heuristic binary check: a NUL byte in the first slice means "don't search". */
export function isLikelyBinary(content: string): boolean {
	const sample = content.length > 8192 ? content.slice(0, 8192) : content;
	return sample.includes("\u0000");
}

/**
 * Decide whether a path is worth searching. Skips excluded directory segments
 * and known binary extensions. Enumeration filter only — does not read content.
 */
export function shouldSearchPath(
	path: string,
	excludes: readonly string[] = DEFAULT_SEARCH_EXCLUDES,
): boolean {
	const normalized = path.replace(/\\/g, "/");
	for (const ex of excludes) {
		// Match the excluded segment anywhere in the path, not just at the root.
		if (normalized === ex || normalized.includes(`/${ex}`) || normalized.startsWith(ex)) {
			return false;
		}
	}
	const lastSlash = normalized.lastIndexOf("/");
	const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
	const dot = base.lastIndexOf(".");
	if (dot > 0) {
		const ext = base.slice(dot + 1).toLowerCase();
		if (BINARY_EXTENSIONS.has(ext)) return false;
	}
	return true;
}

/**
 * Search a sequence of in-memory files for a pattern. The caller is responsible
 * for enumeration and for honoring `shouldSearchPath` / `isLikelyBinary` if it
 * wants those filters — this function searches exactly what it is given.
 */
export function searchFiles(
	files: Iterable<SearchFileInput>,
	options: SearchOptions,
): SearchResult {
	const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
	const maxMatchesPerFile = options.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE;
	const maxPreviewChars = options.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS;
	const regex = compileSearchPattern(options);

	const matches: SearchMatch[] = [];
	let filesSearched = 0;
	let filesMatched = 0;
	let truncated = false;

	outer: for (const file of files) {
		filesSearched++;
		const lines = file.content.split("\n");
		let fileMatchCount = 0;
		lineLoop: for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			regex.lastIndex = 0;
			let m: RegExpExecArray | null = regex.exec(line);
			while (m !== null) {
				const matchStart = m.index;
				const matchEnd = m.index + m[0].length;
				matches.push({
					path: file.path,
					line: i + 1,
					column: matchStart + 1,
					preview: buildPreview(line, matchStart, matchEnd, maxPreviewChars),
				});
				if (fileMatchCount === 0) filesMatched++;
				fileMatchCount++;
				if (matches.length >= maxMatches) {
					truncated = true;
					break outer;
				}
				// Per-file cap stops scanning the rest of this file's lines. We may
				// have left matches behind, so flag the result as truncated.
				if (fileMatchCount >= maxMatchesPerFile) {
					truncated = true;
					break lineLoop;
				}
				// Guard against an infinite loop on a zero-width match.
				if (m[0].length === 0) regex.lastIndex++;
				m = regex.exec(line);
			}
		}
	}

	return { matches, truncated, filesSearched, filesMatched };
}

function plural(n: number, word: string): string {
	if (n === 1) return `${n} ${word}`;
	// Words ending in a sibilant take "-es" (match → matches); the rest take "-s".
	const suffix = /(?:ch|sh|s|x|z)$/.test(word) ? "es" : "s";
	return `${n} ${word}${suffix}`;
}

/**
 * Render a SearchResult into the shared `path:line:preview` output contract,
 * with a summary footer. This is the single formatting authority for both
 * surface tools.
 */
export function formatSearchResults(result: SearchResult): string {
	if (result.matches.length === 0) {
		return `No matches found (${plural(result.filesSearched, "file")} searched).`;
	}
	const lines = result.matches.map((m) => `${m.path}:${m.line}:${m.preview}`);
	let summary = `${plural(result.matches.length, "match")} in ${plural(
		result.filesMatched,
		"file",
	)} (${plural(result.filesSearched, "file")} searched)`;
	if (result.truncated) {
		summary += "; results truncated — more matches exist, narrow your pattern or scope";
	}
	return `${lines.join("\n")}\n\n${summary}`;
}
