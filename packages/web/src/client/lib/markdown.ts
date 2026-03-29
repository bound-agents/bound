import DOMPurify from "dompurify";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import { type Highlighter, createHighlighter } from "shiki";

// ---------------------------------------------------------------------------
// Shiki singleton
// createHighlighter() is async and expensive. The Promise is cached at module
// level so the cost is paid once across all callers.
// ---------------------------------------------------------------------------
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighter({
			themes: ["tokyo-night"],
			langs: [
				"javascript",
				"typescript",
				"sql",
				"python",
				"bash",
				"json",
				"yaml",
				"html",
				"css",
				"plaintext",
			],
		});
	}
	return highlighterPromise;
}

// ---------------------------------------------------------------------------
// Marked instance
// ---------------------------------------------------------------------------

// Marked instance configured with:
//   markedHighlight — delegates fenced code blocks to the Shiki singleton.
const markedInstance = new Marked(
	markedHighlight({
		async: true,
		highlight: async (code: string, lang: string): Promise<string> => {
			// No language specified: return "" so marked-highlight falls back to
			// its default code block rendering (plain <pre><code>, no Shiki styles).
			if (!lang) {
				return "";
			}
			const highlighter = await getHighlighter();
			const supported = highlighter.getLoadedLanguages();
			// Unknown languages fall back to plaintext to avoid Shiki errors.
			const language = supported.includes(lang) ? lang : "plaintext";
			return highlighter.codeToHtml(code, {
				lang: language,
				theme: "tokyo-night",
			});
		},
	}),
);

// ---------------------------------------------------------------------------
// splitOnThinkingBlocks
// ---------------------------------------------------------------------------

export type TextSegment = { kind: "text"; text: string };
export type ThinkingSegment = { kind: "thinking"; text: string };
export type Segment = TextSegment | ThinkingSegment;

/**
 * Splits a message string on `<thinking>...</thinking>` occurrences.
 * Returns an ordered array of TextSegment and ThinkingSegment objects so
 * each can be rendered appropriately by renderMarkdown.
 */
export function splitOnThinkingBlocks(content: string): Segment[] {
	const segments: Segment[] = [];
	const regex = /<thinking>([\s\S]*?)<\/thinking>/gi;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop pattern
	while ((match = regex.exec(content)) !== null) {
		if (match.index > lastIndex) {
			segments.push({
				kind: "text",
				text: content.slice(lastIndex, match.index),
			});
		}
		segments.push({ kind: "thinking", text: match[1] });
		lastIndex = regex.lastIndex;
	}

	if (lastIndex < content.length) {
		segments.push({ kind: "text", text: content.slice(lastIndex) });
	}

	return segments;
}

// ---------------------------------------------------------------------------
// DOMPurify config
// ADD_ATTR: ['style'] — preserves Shiki inline color attributes on code tokens.
// ADD_TAGS: ['details', 'summary'] — preserves thinking block disclosure widgets.
// ---------------------------------------------------------------------------
const DOMPURIFY_CONFIG = {
	ADD_ATTR: ["style"],
	ADD_TAGS: ["details", "summary"],
};

type Sanitizer = (html: string) => string;

// Default sanitizer uses DOMPurify directly — works in the browser where
// window/document are available. Tests inject a jsdom-backed sanitizer via
// the optional second parameter.
const browserSanitize: Sanitizer = (html) => DOMPurify.sanitize(html, DOMPURIFY_CONFIG);

// ---------------------------------------------------------------------------
// renderMarkdown — public API
// ---------------------------------------------------------------------------

/**
 * Renders a markdown string (optionally containing `<thinking>...</thinking>`
 * blocks) to sanitized HTML safe for injection via Svelte `{@html}`.
 *
 * - Thinking blocks are wrapped in `<details class="thinking-block"><summary>Thinking...</summary>`.
 * - Fenced code blocks are syntax-highlighted by the Shiki singleton (tokyo-night theme).
 * - All output is sanitized by DOMPurify with Shiki style attributes and
 *   details/summary tags explicitly allowed.
 *
 * @param content  Raw message string (may contain markdown and thinking blocks).
 * @param sanitize Optional sanitizer override. Defaults to DOMPurify (browser).
 *   Pass a custom sanitizer when calling from test environments where DOMPurify
 *   requires an explicit DOM window.
 */
export async function renderMarkdown(
	content: string,
	sanitize: Sanitizer = browserSanitize,
): Promise<string> {
	const segments = splitOnThinkingBlocks(content);

	const htmlParts = await Promise.all(
		segments.map(async (segment) => {
			let innerHtml = await markedInstance.parse(segment.text);
			// Wrap tables in a div for horizontal scrolling support
			innerHtml = innerHtml.replace(/<table>/g, '<div class="table-wrap"><table>');
			innerHtml = innerHtml.replace(/<\/table>/g, "</table></div>");
			if (segment.kind === "thinking") {
				return `<details class="thinking-block"><summary>Thinking...</summary>${innerHtml}</details>`;
			}
			return innerHtml;
		}),
	);

	return sanitize(htmlParts.join(""));
}
