import { homedir } from "node:os";

/**
 * Tildification helpers for displaying paths in the TUI.
 *
 * All functions here are display-only — never round-trip a tildified path
 * back through filesystem APIs. The tools (boundless_read/write/edit) and the
 * model itself continue to see canonical absolute paths; the user just sees a
 * shorter form on screen.
 */

// Cached at module load — homedir() doesn't change for the life of the process.
const HOME = homedir();
const HOME_SLASH = `${HOME}/`;

/**
 * Replace a leading `$HOME` with `~` for whole-path display.
 *
 * Used for fields where the value is known to BE a path (tool-call file_path
 * headers, the SessionHeader cwd line, etc.). For body text that may contain
 * paths as substrings, use `tildifyText`.
 */
export function tildifyPath(p: string): string {
	if (p === HOME) return "~";
	if (p.startsWith(HOME_SLASH)) return `~${p.slice(HOME.length)}`;
	return p;
}

/**
 * Replace every occurrence of `$HOME/` with `~/` inside freeform text.
 *
 * Used for tool_result bodies, where absolute paths appear as substrings (e.g.
 * `Wrote 1234 bytes to /Users/.../foo.ts`, `Error: ENOENT: ...`, or arbitrary
 * stdout from boundless_bash). The trailing `/` requirement keeps us from
 * mangling fragments that just happen to start with the home prefix
 * (`/Users/user-other`, `/Users/userExtra`) — we only rewrite when the
 * next char is `/`, the canonical path-continuation marker.
 */
export function tildifyText(text: string): string {
	if (!text.includes(HOME_SLASH)) return text;
	return text.split(HOME_SLASH).join("~/");
}
