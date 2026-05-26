import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { formatProvenance } from "./provenance";
import type { ToolHandler, ToolResult } from "./types";

type Filesystem = "host" | "sandbox";

interface CopyArgs {
	source?: unknown;
	source_path?: unknown;
	target?: unknown;
	target_path?: unknown;
}

function isFilesystem(v: unknown): v is Filesystem {
	return v === "host" || v === "sandbox";
}

function errorResult(provenance: ToolResult["content"][number], message: string): ToolResult {
	return {
		content: [provenance, { type: "text", text: message }],
		isError: true,
	};
}

/**
 * Resolve a host-side path: absolute paths used as-is, relative paths
 * resolve against the boundless CWD (same convention as the other
 * boundless_* tools so passengers don't have to remember different rules
 * per tool).
 */
function resolveHostPath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Read raw bytes from the source filesystem. Sandbox reads round-trip
 * through bound's `/api/sandbox/file` HTTP endpoint, which is the whole
 * point of the tool — bytes flow direct between filesystems instead of
 * being scribbled through LLM tool_call/tool_result messages.
 */
async function readSource(
	fs: Filesystem,
	path: string,
	cwd: string,
	boundUrl: string,
): Promise<{ bytes: Buffer } | { error: string; status: "not_found" | "is_dir" | "other" }> {
	if (fs === "host") {
		try {
			const resolved = resolveHostPath(path, cwd);
			return { bytes: readFileSync(resolved) };
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			if (e?.code === "ENOENT") {
				return { error: `host source not found: ${path}`, status: "not_found" };
			}
			if (e?.code === "EISDIR") {
				return { error: `host source is a directory: ${path}`, status: "is_dir" };
			}
			return { error: `host source read failed: ${e?.message ?? String(err)}`, status: "other" };
		}
	}

	// sandbox
	const url = `${boundUrl.replace(/\/$/, "")}/api/sandbox/file?path=${encodeURIComponent(path)}`;
	let res: Response;
	try {
		res = await fetch(url);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: `sandbox source request failed: ${msg}`, status: "other" };
	}

	if (res.status === 404) {
		return { error: `sandbox source not found: ${path}`, status: "not_found" };
	}
	if (!res.ok) {
		let detail = "";
		try {
			detail = await res.text();
		} catch {
			// noop — best effort
		}
		const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}...` : detail;
		return {
			error: `sandbox source read failed (HTTP ${res.status}): ${trimmed}`,
			status: res.status === 400 ? "is_dir" : "other",
		};
	}

	const arrayBuffer = await res.arrayBuffer();
	return { bytes: Buffer.from(arrayBuffer) };
}

/**
 * Write raw bytes to the target filesystem. Host writes create parent
 * directories on the way (matching boundless_write); sandbox writes go
 * over `/api/sandbox/file` PUT and let just-bash's MountableFs handle
 * directory semantics.
 */
async function writeTarget(
	fs: Filesystem,
	path: string,
	cwd: string,
	boundUrl: string,
	bytes: Buffer,
): Promise<{ bytesWritten: number } | { error: string }> {
	if (fs === "host") {
		try {
			const resolved = resolveHostPath(path, cwd);
			mkdirSync(dirname(resolved), { recursive: true });
			writeFileSync(resolved, bytes);
			return { bytesWritten: bytes.byteLength };
		} catch (err) {
			const e = err as NodeJS.ErrnoException;
			return { error: `host target write failed: ${e?.message ?? String(err)}` };
		}
	}

	// sandbox
	const url = `${boundUrl.replace(/\/$/, "")}/api/sandbox/file?path=${encodeURIComponent(path)}`;
	let res: Response;
	try {
		// Wrap bytes in a Blob — Bun's fetch typings narrow BodyInit such
		// that a bare `Buffer` / `Uint8Array` doesn't pass at compile time
		// (ArrayBufferLike vs ArrayBuffer mismatch), even though both work
		// at runtime. Copy into a fresh ArrayBuffer to satisfy BlobPart.
		const ab = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(ab).set(bytes);
		const body = new Blob([ab], { type: "application/octet-stream" });
		res = await fetch(url, {
			method: "PUT",
			body,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: `sandbox target request failed: ${msg}` };
	}

	if (!res.ok) {
		let detail = "";
		try {
			detail = await res.text();
		} catch {
			// noop — best effort
		}
		const trimmed = detail.length > 200 ? `${detail.slice(0, 200)}...` : detail;
		return { error: `sandbox target write failed (HTTP ${res.status}): ${trimmed}` };
	}

	return { bytesWritten: bytes.byteLength };
}

export interface CopyToolDeps {
	hostname: string;
	/** Bound daemon base URL, used for sandbox-side reads/writes. */
	boundUrl: string;
}

export function createCopyTool(deps: CopyToolDeps): ToolHandler {
	return async (args, _signal, cwd) => {
		return copyToolImpl(deps, args as CopyArgs, cwd);
	};
}

async function copyToolImpl(deps: CopyToolDeps, args: CopyArgs, cwd: string): Promise<ToolResult> {
	const provenance = formatProvenance(deps.hostname, cwd, "boundless_copy");

	// Argument validation
	if (!isFilesystem(args.source)) {
		return errorResult(provenance, 'Error: source is required and must be "host" or "sandbox"');
	}
	if (!isFilesystem(args.target)) {
		return errorResult(provenance, 'Error: target is required and must be "host" or "sandbox"');
	}
	if (typeof args.source_path !== "string" || args.source_path.length === 0) {
		return errorResult(provenance, "Error: source_path is required and must be a non-empty string");
	}
	if (typeof args.target_path !== "string" || args.target_path.length === 0) {
		return errorResult(provenance, "Error: target_path is required and must be a non-empty string");
	}

	const source: Filesystem = args.source;
	const target: Filesystem = args.target;
	const sourcePath: string = args.source_path;
	const targetPath: string = args.target_path;

	const readResult = await readSource(source, sourcePath, cwd, deps.boundUrl);
	if ("error" in readResult) {
		return errorResult(provenance, `Error: ${readResult.error}`);
	}

	const writeResult = await writeTarget(target, targetPath, cwd, deps.boundUrl, readResult.bytes);
	if ("error" in writeResult) {
		return errorResult(provenance, `Error: ${writeResult.error}`);
	}

	return {
		content: [
			provenance,
			{
				type: "text",
				text: `Copied ${writeResult.bytesWritten} bytes from ${source}:${sourcePath} to ${target}:${targetPath}`,
			},
		],
	};
}

/** Default-bound handler used by tests — production code routes through createCopyTool. */
export const copyTool: ToolHandler = createCopyTool({
	hostname: "unknown",
	boundUrl: "http://localhost:3001",
});
