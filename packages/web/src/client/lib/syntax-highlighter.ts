/**
 * Browser-only Shiki highlighter.
 *
 * The shared package's barrel export includes server-side code intelligence
 * (including native tree-sitter bindings). Keep the web renderer on Shiki's
 * browser-compatible module graph rather than importing that barrel.
 */
import {
	type BundledLanguage,
	type BundledTheme,
	type Highlighter,
	createHighlighter,
} from "shiki";

const SYNTAX_LANGS: readonly BundledLanguage[] = [
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

export const SYNTAX_THEME: BundledTheme = "tokyo-night";

const PLAINTEXT = "plaintext" as const;
type LangTag = BundledLanguage | typeof PLAINTEXT;

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

export async function getHighlighter(): Promise<Highlighter> {
	if (highlighter) return highlighter;
	if (!initPromise) {
		initPromise = createHighlighter({
			themes: [SYNTAX_THEME],
			langs: [...SYNTAX_LANGS],
		}).then((created) => {
			highlighter = created;
			return created;
		});
	}
	return initPromise;
}

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
