/**
 * Shared Shiki-based syntax highlighting.
 *
 * Owns the single source of truth for the language list, theme, and
 * highlighter singleton consumed by both the web UI (HTML output via
 * marked-highlight) and the TUI (token output rendered as Ink <Text>
 * elements).
 *
 * Why a singleton: createHighlighter() loads WASM (Oniguruma) plus the
 * grammars and theme — it is async and expensive. We do it once per
 * process. The web UI awaits getHighlighter() lazily on first render;
 * the TUI calls prewarmHighlighter() at startup before mounting any
 * UI, because Ink's <Static> commits messages to the terminal and
 * cannot reflow them later — code blocks rendered as plain text would
 * stay plain text.
 *
 * Why these langs: matches what we tag fenced code blocks with in
 * practice (see docs/, agent prompts, and the kinds of files boundless
 * reads/writes most). Adding a new language is a one-line edit here
 * that flows to both surfaces.
 */

import {
	type BundledLanguage,
	type BundledTheme,
	type Highlighter,
	type ThemedToken,
	createHighlighter,
} from "shiki";

/**
 * Languages bundled into the highlighter. Both web and TUI fall back
 * to "plaintext" when a fence's lang tag is unknown or absent.
 * "plaintext" is shiki's special pass-through language and doesn't
 * need to be loaded — it's not part of `BundledLanguage`.
 */
export const SYNTAX_LANGS: readonly BundledLanguage[] = [
	"javascript",
	"typescript",
	"sql",
	"python",
	"bash",
	"json",
	"yaml",
	"html",
	"css",
] as const;

const PLAINTEXT = "plaintext" as const;
type LangTag = BundledLanguage | typeof PLAINTEXT;

/** Theme name used for both web and TUI rendering. */
export const SYNTAX_THEME: BundledTheme = "tokyo-night";

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

/**
 * Idempotently load the shiki highlighter. Safe to call multiple
 * times; concurrent calls share a single underlying init.
 *
 * On the web, callers `await getHighlighter()` directly on first
 * render. In the TUI, callers should `await prewarmHighlighter()`
 * once at startup before any code path that might highlight.
 */
export async function getHighlighter(): Promise<Highlighter> {
	if (highlighter) return highlighter;
	if (!initPromise) {
		initPromise = createHighlighter({
			themes: [SYNTAX_THEME],
			langs: [...SYNTAX_LANGS],
		}).then((h) => {
			highlighter = h;
			return h;
		});
	}
	return initPromise;
}

/**
 * Block until the highlighter is ready. The TUI calls this at boot;
 * after it resolves, getHighlighterSync() is safe.
 */
export async function prewarmHighlighter(): Promise<void> {
	await getHighlighter();
}

/**
 * Return the highlighter synchronously, or null if it hasn't been
 * warmed yet. The TUI uses this in render paths after a successful
 * prewarmHighlighter() at boot — the null return is a safety valve
 * that produces plain text rather than crashing if invariants slip.
 */
export function getHighlighterSync(): Highlighter | null {
	return highlighter;
}

/**
 * Normalize a fence/extension lang tag to one of SYNTAX_LANGS.
 * Returns "plaintext" for unknown tags. Keeps both consumers
 * consistent on aliasing (e.g. `js` → `javascript`, `ts` →
 * `typescript`, `sh`/`shell` → `bash`).
 */
export function normalizeLang(lang: string | null | undefined): LangTag {
	if (!lang) return PLAINTEXT;
	const lower = lang.toLowerCase();
	const aliased = LANG_ALIASES[lower] ?? lower;
	return (SYNTAX_LANGS as readonly string[]).includes(aliased)
		? (aliased as BundledLanguage)
		: PLAINTEXT;
}

const LANG_ALIASES: Record<string, string> = {
	js: "javascript",
	ts: "typescript",
	tsx: "typescript",
	jsx: "javascript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	yml: "yaml",
	htm: "html",
	py: "python",
};

/**
 * Highlight code to HTML. Used by the web UI via marked-highlight.
 * Async because callers may invoke before the highlighter has finished
 * loading; subsequent calls hit the cached singleton.
 */
export async function highlightToHtml(
	code: string,
	lang: string | null | undefined,
): Promise<string> {
	const h = await getHighlighter();
	return h.codeToHtml(code, {
		lang: normalizeLang(lang),
		theme: SYNTAX_THEME,
	});
}

/**
 * Tokenize code into a 2D array of themed tokens (lines × tokens).
 * Used by the TUI to render <Text color={token.color}> per token.
 *
 * Synchronous: requires a prior prewarmHighlighter(). Returns a
 * single line of plain-content tokens if the highlighter isn't ready,
 * so the TUI degrades to uncolored text rather than throwing.
 */
export function highlightToTokens(code: string, lang: string | null | undefined): ThemedToken[][] {
	const h = highlighter;
	if (!h) {
		// Fallback: one token per line, no color. Preserves layout so
		// callers don't need to special-case the unwarmed path.
		return code.split("\n").map((line) => [{ content: line, offset: 0 } as ThemedToken]);
	}
	const result = h.codeToTokens(code, {
		lang: normalizeLang(lang),
		theme: SYNTAX_THEME,
	});
	return result.tokens;
}

export type { ThemedToken } from "shiki";
