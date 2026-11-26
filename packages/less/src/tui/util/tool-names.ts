import { isShellToolName } from "../../tools/shell";

/**
 * Transcript-facing tool classification. Matches by suffix so the boundless_*
 * host tools and the bms_* sandbox tools classify alike; `query` is the
 * built-in database tool's exact name.
 */
export type ToolDisplayKind =
	"shell" | "read" | "search" | "query" | "write" | "edit" | "yard" | "other";

export function classifyTool(name: string): ToolDisplayKind {
	// isShellToolName is anchored on `boundless_`; the `_bash` suffix also
	// covers the sandbox shell (bms_bash).
	if (isShellToolName(name) || name.endsWith("_bash")) return "shell";
	if (name === "query") return "query";
	if (name === "yard") return "yard";
	if (name.endsWith("_read")) return "read";
	if (name.endsWith("_search")) return "search";
	if (name.endsWith("_write")) return "write";
	if (name.endsWith("_edit")) return "edit";
	return "other";
}

/**
 * Compact tools (read/search/query) collapse to one committed line per
 * invocation instead of a call row plus a multi-line result body.
 */
export function isCompactToolName(name: string): boolean {
	const kind = classifyTool(name);
	return kind === "read" || kind === "search" || kind === "query";
}

/** Drop the `boundless_` / `bms_` namespace prefix for display. */
export function displayToolName(name: string): string {
	if (name.startsWith("boundless_")) return name.slice("boundless_".length);
	if (name.startsWith("bms_")) return name.slice("bms_".length);
	return name;
}

/** The file a tool call targets: boundless_* tools pass `file_path`, bms_* tools pass `path`. */
export function toolTargetPath(input: Record<string, unknown> | undefined): string | undefined {
	if (typeof input?.file_path === "string") return input.file_path;
	if (typeof input?.path === "string") return input.path;
	return undefined;
}
