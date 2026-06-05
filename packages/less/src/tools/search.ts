import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	type SearchFileInput,
	formatSearchResults,
	isLikelyBinary,
	searchFiles,
	shouldSearchPath,
} from "@bound/shared";
import { formatProvenance } from "./provenance";
import type { ToolHandler } from "./types";

/** Skip individual files larger than this to avoid pulling huge blobs into memory. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Recursively collect searchable file paths under `root`, pruning excluded
 * directories early (so we never descend into node_modules/.git/etc). Paths are
 * returned relative to `cwd` for readable output. Enumeration is cheap — it does
 * not read file content; that happens lazily in the search generator.
 */
function collectPaths(root: string, cwd: string): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) continue;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable directory — skip
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			const rel = relative(cwd, abs);
			if (entry.isDirectory()) {
				// shouldSearchPath checks excluded dir segments; append "/" so a
				// directory named e.g. "dist" is matched by the "dist/" exclude.
				if (shouldSearchPath(`${rel}/`)) stack.push(abs);
			} else if (entry.isFile()) {
				if (shouldSearchPath(rel)) out.push(rel);
			}
		}
	}
	return out;
}

/**
 * Lazily yield `{ path, content }` for each candidate path. Reading is deferred
 * until the consumer (the shared search core) pulls the file, so once the core
 * hits its match cap and stops iterating, remaining files are never read.
 */
function* readLazily(paths: string[], cwd: string): Generator<SearchFileInput> {
	for (const rel of paths) {
		let content: string;
		try {
			const buffer = readFileSync(resolve(cwd, rel));
			if (buffer.length > MAX_FILE_BYTES) continue;
			content = buffer.toString("utf-8");
		} catch {
			continue; // unreadable file — skip
		}
		if (isLikelyBinary(content)) continue;
		yield { path: rel, content };
	}
}

export function createSearchTool(hostname: string): ToolHandler {
	return async (args, _signal, cwd) => {
		const provenance = formatProvenance(hostname, cwd, "boundless_search");
		const {
			pattern,
			path: searchPath,
			case_insensitive,
			fixed_strings,
		} = args as {
			pattern?: string;
			path?: string;
			case_insensitive?: boolean;
			fixed_strings?: boolean;
		};

		if (!pattern || typeof pattern !== "string") {
			return {
				content: [
					provenance,
					{ type: "text", text: "Error: pattern is required and must be a string" },
				],
				isError: true,
			};
		}

		const root =
			typeof searchPath === "string" && searchPath.length > 0
				? isAbsolute(searchPath)
					? searchPath
					: resolve(cwd, searchPath)
				: cwd;

		try {
			const paths = collectPaths(root, cwd);
			const result = searchFiles(readLazily(paths, cwd), {
				pattern,
				flags: case_insensitive ? "i" : undefined,
				fixedStrings: fixed_strings === true,
			});
			return {
				content: [provenance, { type: "text", text: formatSearchResults(result) }],
			};
		} catch (err) {
			// compileSearchPattern throws on an invalid regex — surface it cleanly.
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [provenance, { type: "text", text: `Error: ${message}` }],
				isError: true,
			};
		}
	};
}

export const searchTool: ToolHandler = createSearchTool("unknown");
