import { insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, type MemoryTier, deterministicUUID } from "@bound/shared";
import { z } from "zod";
import {
	cascadeDeleteEdges,
	getNeighbors,
	removeEdges,
	traverseGraph,
	upsertEdge,
} from "../graph-queries";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

const memorySchema = z.object({
	action: z
		.enum(["store", "forget", "search", "connect", "disconnect", "traverse", "neighbors"])
		.describe("Memory operation to perform"),
	key: z
		.string()
		.optional()
		.describe("Memory key (for store, forget, search, traverse, neighbors)"),
	value: z.string().optional().describe("Memory value (for store)"),
	source_tag: z
		.string()
		.optional()
		.describe("Provenance tag (for store; defaults to task/thread/agent)"),
	tier: z
		.enum(["pinned", "summary", "default", "detail"])
		.optional()
		.describe("Memory tier (for store)"),
	prefix: z.string().optional().describe("Key prefix for batch forget"),
	source_key: z.string().optional().describe("Source memory key (for connect, disconnect)"),
	target_key: z.string().optional().describe("Target memory key (for connect, disconnect)"),
	relation: z
		.string()
		.optional()
		.describe("Edge relation type from CANONICAL_RELATIONS (for connect, disconnect)"),
	weight: z.number().optional().describe("Edge weight 0-10 (for connect; default 1.0)"),
	context: z.string().optional().describe("Free-text context phrase (for connect)"),
	depth: z.number().int().optional().describe("Traversal depth 1-3 (for traverse; default 2)"),
	direction: z
		.enum(["out", "in", "both"])
		.optional()
		.describe("Neighbor direction (for neighbors; default 'both')"),
});

type MemoryInput = z.infer<typeof memorySchema>;

const PINNED_PREFIXES = ["_standing", "_feedback", "_policy", "_pinned"];

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"shall",
	"can",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"about",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"they",
	"what",
	"how",
	"when",
	"where",
	"why",
	"which",
	"who",
	"not",
	"no",
	"and",
	"or",
	"but",
	"if",
]);

function handleStore(args: MemoryInput, ctx: ToolContext): string {
	const key = args.key;
	const value = args.value;
	if (!key || !value) {
		return "Error: store requires 'key' and 'value' parameters";
	}
	const source = args.source_tag || ctx.taskId || ctx.threadId || "agent";
	const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
	const now = new Date().toISOString();

	// Determine tier: apply rules in priority order
	// 1. Check for pinned prefixes — always pin
	let resolvedTier: MemoryTier = "default";
	const hasPinnedPrefix = PINNED_PREFIXES.some((prefix) => key.startsWith(`${prefix}:`));
	if (hasPinnedPrefix) {
		resolvedTier = "pinned";
	} else if (args.tier) {
		resolvedTier = args.tier;
	}

	// bun:sqlite .get() returns null (not undefined) when no row found
	const existing = ctx.db
		.prepare("SELECT id, deleted, tier FROM semantic_memory WHERE key = ?")
		.get(key) as { id: string; deleted: number; tier: MemoryTier } | null;

	if (existing) {
		// Updating existing entry: pinned prefixes always correct to "pinned", else preserve tier unless explicitly overridden
		const tierForUpdate = hasPinnedPrefix ? "pinned" : args.tier ? resolvedTier : existing.tier;
		updateRow(
			ctx.db,
			"semantic_memory",
			memoryId,
			{ value, source, last_accessed_at: now, deleted: 0, tier: tierForUpdate },
			ctx.siteId,
		);
	} else {
		insertRow(
			ctx.db,
			"semantic_memory",
			{
				id: memoryId,
				key,
				value,
				source,
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
				tier: resolvedTier,
			},
			ctx.siteId,
		);
	}

	return `Memory saved: ${key}`;
}

function handleForget(args: MemoryInput, ctx: ToolContext): string {
	const prefix = args.prefix;
	if (prefix) {
		const entries = ctx.db
			.prepare("SELECT id, key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
			.all(`${prefix}%`) as Array<{ id: string; key: string }>;

		if (entries.length === 0) {
			return `No memories found with prefix: ${prefix}`;
		}

		let totalEdges = 0;
		for (const entry of entries) {
			softDelete(ctx.db, "semantic_memory", entry.id, ctx.siteId);
			totalEdges += cascadeDeleteEdges(ctx.db, entry.key, ctx.siteId);
		}

		const edgeSuffix = totalEdges > 0 ? ` (${totalEdges} edge(s) also removed)` : "";
		return `Deleted ${entries.length} memories with prefix: ${prefix}${edgeSuffix}`;
	}

	const key = args.key;
	if (!key) {
		return "Error: forget requires 'key' parameter (or use 'prefix' for batch deletion)";
	}

	// bun:sqlite .get() returns null (not undefined) when no row found
	const existing = ctx.db
		.prepare("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(key) as { id: string; tier: MemoryTier } | null;

	if (!existing) {
		return `Error: Memory not found: ${key}`;
	}

	// If forgetting a summary, promote detail children to default
	if (existing.tier === "summary") {
		const children = ctx.db
			.prepare(
				"SELECT target_key FROM memory_edges WHERE source_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.all(key) as Array<{ target_key: string }>;

		for (const child of children) {
			const childRow = ctx.db
				.prepare("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get(child.target_key) as { id: string; tier: MemoryTier } | null;

			if (childRow && childRow.tier === "detail") {
				updateRow(ctx.db, "semantic_memory", childRow.id, { tier: "default" }, ctx.siteId);
			}
		}
	}

	// Use existing.id — not deterministicUUID — because entries created by
	// thread fact extraction, heartbeat, or research evaluator use random UUIDs.
	softDelete(ctx.db, "semantic_memory", existing.id, ctx.siteId);

	// Cascade: soft-delete all edges referencing this key (as source or target)
	const edgesCascaded = cascadeDeleteEdges(ctx.db, key, ctx.siteId);

	const edgeSuffix = edgesCascaded > 0 ? ` (${edgesCascaded} edge(s) also removed)` : "";
	return `Memory deleted: ${key}${edgeSuffix}`;
}

function handleSearch(args: MemoryInput, ctx: ToolContext): string {
	const queryText = args.key;
	if (!queryText) {
		return "Error: search requires 'key' parameter";
	}

	const keywords = queryText
		.toLowerCase()
		.replace(/[^a-z0-9_\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

	if (keywords.length === 0) {
		return "No searchable keywords found in query.";
	}

	const likeConditions = keywords.map(
		() => "(LOWER(key) LIKE '%' || ? || '%' OR LOWER(value) LIKE '%' || ? || '%')",
	);
	const params = keywords.flatMap((kw) => [kw, kw]);

	const results = ctx.db
		.prepare(
			`SELECT key, value, source, modified_at FROM semantic_memory
             WHERE deleted = 0
               AND key NOT LIKE '_internal.%'
               AND (${likeConditions.join(" OR ")})
             ORDER BY modified_at DESC LIMIT 20`,
		)
		.all(...params) as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
	}>;

	if (results.length === 0) {
		return `No memories matched: ${queryText}`;
	}

	const lines = results.map(
		(r) =>
			`- ${r.key}: ${r.value.substring(0, 100)}${r.value.length > 100 ? "..." : ""} [${r.source || "unknown"}]`,
	);
	return `Found ${results.length} memories:\n${lines.join("\n")}`;
}

function handleConnect(args: MemoryInput, ctx: ToolContext): string {
	const src = args.source_key;
	const tgt = args.target_key;
	const rel = args.relation;
	const weight = args.weight ?? 1.0;
	const context = args.context;

	if (!src || !tgt || !rel) {
		return "Error: connect requires 'source_key', 'target_key', and 'relation' parameters";
	}

	if (Number.isNaN(weight) || weight < 0 || weight > 10) {
		return "Error: weight must be a number between 0 and 10";
	}

	// Validate both memory keys exist (active, not soft-deleted)
	const srcExists = ctx.db
		.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(src);
	if (!srcExists) {
		return `Error: source memory not found: ${src}`;
	}

	const tgtExists = ctx.db
		.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(tgt);
	if (!tgtExists) {
		return `Error: target memory not found: ${tgt}`;
	}

	const id = upsertEdge(ctx.db, src, tgt, rel, weight, ctx.siteId, context);

	// Handle tier transitions for summarizes edges
	if (rel === "summarizes") {
		const target = ctx.db
			.prepare("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
			.get(tgt) as { id: string; tier: MemoryTier } | null;
		if (target && target.tier === "default") {
			updateRow(ctx.db, "semantic_memory", target.id, { tier: "detail" }, ctx.siteId);
		}
		// pinned and summary targets are NOT demoted
	}

	const contextSuffix = context ? `, context="${context}"` : "";
	return `Edge created: ${src} --[${rel}]--> ${tgt} (weight=${weight}${contextSuffix}, id=${id})`;
}

function handleDisconnect(args: MemoryInput, ctx: ToolContext): string {
	const src = args.source_key;
	const tgt = args.target_key;
	const rel = args.relation;

	if (!src || !tgt) {
		return "Error: disconnect requires 'source_key' and 'target_key' parameters";
	}

	const count = removeEdges(ctx.db, src, tgt, rel, ctx.siteId);
	if (count === 0) {
		return `Error: no edges found between ${src} and ${tgt}${rel ? ` with relation ${rel}` : ""}`;
	}

	// Handle orphan promotion for summarizes edges
	// Check if this was (or could have been) a summarizes edge
	if (rel === "summarizes" || !rel) {
		// Check if target has any remaining incoming summarizes edges
		const remaining = ctx.db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get(tgt) as { cnt: number };

		if (remaining.cnt === 0) {
			const target = ctx.db
				.prepare("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get(tgt) as { id: string; tier: MemoryTier } | null;
			if (target && target.tier === "detail") {
				updateRow(ctx.db, "semantic_memory", target.id, { tier: "default" }, ctx.siteId);
			}
		}
	}

	return `Removed ${count} edge(s) between ${src} and ${tgt}`;
}

function handleTraverse(args: MemoryInput, ctx: ToolContext): string {
	const key = args.key;
	if (!key) {
		return "Error: traverse requires 'key' parameter";
	}

	const depth = args.depth ?? 2;
	const relation = args.relation;

	if (Number.isNaN(depth) || depth < 1) {
		return "Error: depth must be a positive integer (1-3)";
	}

	const results = traverseGraph(ctx.db, key, depth, relation);

	if (results.length === 0) {
		return `No connected entries found from: ${key}`;
	}

	const lines = results.map((r) => {
		const ctxSuffix = r.viaContext ? ` (${r.viaContext})` : "";
		return `${"  ".repeat(r.depth)}${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [depth ${r.depth}, ${r.viaRelation}${ctxSuffix}]`;
	});
	return `Graph traversal from ${key} (depth=${Math.min(depth, 3)}, ${results.length} entries):\n${lines.join("\n")}`;
}

function handleNeighbors(args: MemoryInput, ctx: ToolContext): string {
	const key = args.key;
	if (!key) {
		return "Error: neighbors requires 'key' parameter";
	}

	const dir = args.direction ?? "both";

	const results = getNeighbors(ctx.db, key, dir);

	if (results.length === 0) {
		return `No neighbors found for: ${key}`;
	}

	const lines = results.map((r) => {
		const ctxSuffix = r.context ? ` (${r.context})` : "";
		return `  ${r.direction === "out" ? "-->" : "<--"} ${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [${r.relation}, w=${r.weight}${ctxSuffix}]`;
	});
	return `Neighbors of ${key} (${results.length} connections):\n${lines.join("\n")}`;
}

export function createMemoryTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(memorySchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "memory",
				description:
					"Semantic memory operations: store, forget, search, connect, disconnect, traverse, neighbors",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(memorySchema, raw, "memory");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				switch (input.action) {
					case "store":
						return handleStore(input, ctx);
					case "forget":
						return handleForget(input, ctx);
					case "search":
						return handleSearch(input, ctx);
					case "connect":
						return handleConnect(input, ctx);
					case "disconnect":
						return handleDisconnect(input, ctx);
					case "traverse":
						return handleTraverse(input, ctx);
					case "neighbors":
						return handleNeighbors(input, ctx);
					default: {
						const _exhaustive: never = input.action;
						return `Error: Unknown action "${_exhaustive}"`;
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
