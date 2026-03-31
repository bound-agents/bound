import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";

/**
 * Minimal structural type for content blocks.
 * Satisfied by ContentBlock from @bound/llm without requiring the import.
 */
interface TokenCountableBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

let encoding: Tiktoken | null = null;

function getEncoding(): Tiktoken {
	if (!encoding) {
		encoding = new Tiktoken(cl100k_base);
	}
	return encoding;
}

/**
 * Count tokens in a plain text string using cl100k_base encoding.
 * Labeled "estimated" in UI because cl100k_base approximates Claude's tokenizer (~5-10% variance).
 * Returns 0 for empty strings.
 */
export function countTokens(text: string): number {
	if (text.length === 0) return 0;
	return getEncoding().encode(text).length;
}

/**
 * Count tokens in message content (string or content block array).
 * For text blocks, counts tokens of the text content.
 * For other block types (tool_use, image, document), counts tokens of the JSON representation.
 */
export function countContentTokens(
	content: string | TokenCountableBlock[]
): number {
	if (typeof content === "string") return countTokens(content);
	return content.reduce((sum, block) => {
		if (block.type === "text" && block.text)
			return sum + countTokens(block.text);
		return sum + countTokens(JSON.stringify(block));
	}, 0);
}
