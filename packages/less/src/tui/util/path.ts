import { homedir } from "node:os";

/**
 * Tildification helpers for displaying paths in the TUI.
 *
 * All functions here are display-only — never round-trip a tildified path
 * back through filesystem APIs. The tools (boundless_read/write/edit) and the
 * model itself continue to see canonical absolute paths; the user just sees a
 * shorter form on screen.
 *
 * Both POSIX (`/`) and Windows (`\`) separators are handled: on Windows
 * `homedir()` returns e.g. `C:\Users\alice` and paths arrive backslash-
 * separated, so a hardcoded `/` boundary would never match and the path would
 * render untildified.
 */

// Cached at module load — homedir() doesn't change for the life of the process.
const HOME = homedir();

/** A path separator, either POSIX or Windows. */
function isSep(ch: string | undefined): boolean {
	return ch === "/" || ch === "\\";
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace a leading `$HOME` with `~` for whole-path display, against an
 * explicitly supplied home directory. Exposed for cross-platform testing;
 * production callers use {@link tildifyPath}, which binds the cached `HOME`.
 */
export function tildifyPathFrom(home: string, p: string): string {
	if (!home) return p;
	if (p === home) return "~";
	// Only collapse when `home` is followed by a separator, so a sibling like
	// `/Users/alice-other` or `C:\Users\alice-other` is left untouched. The
	// matched separator is preserved (`~/Documents` or `~\Documents`).
	if (p.length > home.length && p.startsWith(home) && isSep(p[home.length])) {
		return `~${p.slice(home.length)}`;
	}
	return p;
}

/**
 * Replace a leading `$HOME` with `~` for whole-path display.
 *
 * Used for fields where the value is known to BE a path (tool-call file_path
 * headers, the SessionHeader cwd line, etc.). For body text that may contain
 * paths as substrings, use `tildifyText`.
 */
export function tildifyPath(p: string): string {
	return tildifyPathFrom(HOME, p);
}

/**
 * Replace every occurrence of `$HOME` + separator with `~` + the same
 * separator inside freeform text, against an explicitly supplied home
 * directory. Exposed for cross-platform testing; production callers use
 * {@link tildifyText}.
 */
export function tildifyTextFrom(home: string, text: string): string {
	if (!home || !text.includes(home)) return text;
	// Match `home` followed by either separator, capturing the separator so it
	// survives the rewrite. The trailing-separator requirement keeps us from
	// mangling fragments that merely start with the home prefix
	// (`/Users/alice-other`, `C:\Users\aliceExtra`).
	const re = new RegExp(`${escapeRegExp(home)}([/\\\\])`, "g");
	return text.replace(re, "~$1");
}

/**
 * Replace every occurrence of `$HOME/` (or `$HOME\`) with `~/` (or `~\`)
 * inside freeform text.
 *
 * Used for tool_result bodies, where absolute paths appear as substrings (e.g.
 * `Wrote 1234 bytes to /Users/.../foo.ts`, `Error: ENOENT: ...`, or arbitrary
 * stdout from boundless_bash).
 */
export function tildifyText(text: string): string {
	return tildifyTextFrom(HOME, text);
}
