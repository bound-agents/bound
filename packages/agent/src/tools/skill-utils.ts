/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Shared utility for both native skill tool and any other code that needs to parse skill frontmatter.
 */
export function parseFrontmatter(
	content: string,
): { data: Record<string, string>; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) return null;
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			data[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
		}
	}
	return { data, body: match[2] ?? "" };
}
