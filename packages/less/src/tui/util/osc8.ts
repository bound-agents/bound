/**
 * OSC 8 terminal hyperlinks.
 *
 * A terminal that speaks OSC 8 (iTerm2, WezTerm, Kitty, Ghostty, modern VTE
 * terminals, tmux with passthrough) renders the wrapped label as a real
 * clickable link; every other terminal shows the bare label and silently
 * drops the escape. So this degrades cleanly — there is no capability gate to
 * check, the same way {@link ../components/Markdown} already emits OSC 8 for
 * web links unconditionally.
 *
 * The escape is `ESC ] 8 ; <params> ; <uri> BEL <label> ESC ] 8 ; ; BEL`. The
 * empty params slot between the two `;` is where a link id would go; it is
 * omitted, and terminals coalesce adjacent same-URI cells without one.
 */

/**
 * Wrap `label` in an OSC 8 hyperlink pointing at `href`.
 *
 * The escape bytes are zero-width to string-width@7 / wrap-ansi@9 (Ink's own
 * measurement deps), so a label wrapped here measures exactly as its visible
 * text — callers can wrap/pad the label first and hyperlink the result, or
 * the reverse, without disturbing layout.
 *
 * `href` is defensively stripped of C0/C1 control bytes: an OSC string
 * terminates on BEL/ST and an embedded ESC could smuggle a further control
 * sequence into stdout, so a malformed URI must never break out of the
 * hyperlink envelope. (Mirrors the sanitization in `terminal-title.ts`.)
 */
export function osc8Link(href: string, label: string): string {
	let safeHref = "";
	for (const ch of href) {
		const code = ch.charCodeAt(0);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
		safeHref += ch;
	}
	return `\u001B]8;;${safeHref}\u0007${label}\u001B]8;;\u0007`;
}

/**
 * Build a `file://` URI from an ABSOLUTE filesystem path, or return null when
 * the path is not absolute (no anchor to resolve it against — the caller
 * should render plain text instead of a broken link).
 *
 * Each path segment is percent-encoded independently so spaces and other
 * reserved characters survive the terminal's URI parse, while the `/`
 * separators stay literal. The host component is left empty (`file:///abs`),
 * which every file-URI-honoring terminal and editor resolves as local.
 */
export function pathToFileUri(absPath: string): string | null {
	if (!absPath.startsWith("/")) return null;
	const encoded = absPath
		.split("/")
		.map((seg) => encodeURIComponent(seg))
		.join("/");
	return `file://${encoded}`;
}

/**
 * Resolve a tool-supplied path (absolute OR relative to `cwd`) into a
 * `file://` URI suitable for {@link osc8Link}. Relative paths are joined onto
 * `cwd` — boundless file tools routinely pass repo-relative paths like
 * `packages/less/src/x.ts`, and without the working directory those can't
 * become a valid absolute file URI. Returns null when no absolute path can be
 * formed (relative path with no usable `cwd`).
 */
export function resolveFileHref(path: string, cwd?: string): string | null {
	if (path.startsWith("/")) return pathToFileUri(path);
	if (cwd?.startsWith("/")) {
		return pathToFileUri(`${cwd.replace(/\/+$/, "")}/${path}`);
	}
	return null;
}

/**
 * Render `label` as an OSC 8 hyperlink to the file at `path` (resolved against
 * `cwd`), or return `label` unchanged when no absolute file URI can be formed.
 * The common convenience wrapper: callers pass the display label (often
 * tildified) and the raw path, and get back a string safe to drop into a
 * `<Text>` child.
 */
export function linkifyPath(label: string, path: string | null | undefined, cwd?: string): string {
	if (!path) return label;
	const href = resolveFileHref(path, cwd);
	return href ? osc8Link(href, label) : label;
}
