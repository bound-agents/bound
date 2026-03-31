export type FileCategory = "code" | "markdown" | "image" | "text" | "binary";

const CODE_EXTENSIONS = new Set([
	".ts",
	".js",
	".tsx",
	".jsx",
	".py",
	".sql",
	".bash",
	".sh",
	".json",
	".yaml",
	".yml",
	".html",
	".css",
	".scss",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

const TEXT_EXTENSIONS = new Set([".txt", ".log", ".env", ".csv", ".toml", ".ini", ".cfg"]);

/**
 * Maps file extension to shiki language identifier.
 * Returns null for non-code files.
 */
export function extensionToLanguage(ext: string): string | null {
	const map: Record<string, string> = {
		".ts": "typescript",
		".tsx": "typescript",
		".js": "javascript",
		".jsx": "javascript",
		".py": "python",
		".sql": "sql",
		".bash": "bash",
		".sh": "bash",
		".json": "json",
		".yaml": "yaml",
		".yml": "yaml",
		".html": "html",
		".css": "css",
		".scss": "css",
	};
	return map[ext] ?? null;
}

/**
 * Determines the render category for a file based on extension and binary flag.
 *
 * @param filename The file name (e.g., "index.ts")
 * @param isBinary Whether the file is binary (is_binary field, 0 or 1)
 * @returns The render category
 */
export function getFileCategory(filename: string, isBinary: number): FileCategory {
	const ext = filename.includes(".") ? `.${filename.split(".").pop()?.toLowerCase()}` : "";

	if (ext === ".md") return "markdown";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (CODE_EXTENSIONS.has(ext)) return "code";
	if (TEXT_EXTENSIONS.has(ext)) return "text";

	// If it has a known text extension but isn't code/markdown/text,
	// and it's not binary, treat as plain text
	if (isBinary === 0) return "text";

	// Binary non-image files get the fallback
	return "binary";
}
