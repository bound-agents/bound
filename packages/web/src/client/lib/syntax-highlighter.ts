/**
 * Browser-only Shiki highlighter. Imports the `@bound/shared/syntax` subpath,
 * never the barrel: the barrel pulls native tree-sitter bindings.
 */
import { SYNTAX_LANGS, SYNTAX_THEME } from "@bound/shared/syntax";
import { type BundledLanguage, type Highlighter, createHighlighter } from "shiki";

export { SYNTAX_THEME };

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
