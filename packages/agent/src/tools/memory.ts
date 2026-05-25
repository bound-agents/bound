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

/**
 * Key prefixes whose presence forces the resulting memory entry to
 * the `pinned` tier regardless of any explicit tier argument.
 *
 * Per CONTRIBUTING.md "Memory tiers" — prefixed keys carry standing
 * authority (operational rules, feedback corrections, policy
 * pointers, explicit pins), so the agent must not be able to
 * accidentally demote them by passing an explicit tier on store.
 */
export const PINNED_PREFIXES = ["_standing", "_feedback", "_policy", "_pinned"] as const;

/** True when the key starts with `<prefix>:` for any pinned prefix. */
export function hasPinnedPrefix(key: string): boolean {
	return PINNED_PREFIXES.some((prefix) => key.startsWith(`${prefix}:`));
}

/**
 * Resolve the tier for a memory entry from its key and an optional
 * explicit-tier argument.
 *
 * Pure function. The rules, in priority order:
 *   1. Pinned-prefix keys ALWAYS resolve to `pinned`. The explicit
 *      tier argument is ignored. This is the invariant that prevents
 *      operational rules from being accidentally demoted.
 *   2. Otherwise, an explicit tier argument wins.
 *   3. Otherwise, default to `"default"`.
 *
 * Property-tested at `__tests__/tier-classification.property.test.ts`
 * for totality, idempotence, and the priority-ordering invariant.
 */
export function resolveTierForKey(key: string, explicitTier?: MemoryTier): MemoryTier {
	if (hasPinnedPrefix(key)) return "pinned";
	if (explicitTier !== undefined) return explicitTier;
	return "default";
}

function handleStore(args: MemoryInput, ctx: ToolContext): string {
	const key = args.key;
	const value = args.value;
	if (!key || !value) {
		return "Error: store requires 'key' and 'value' parameters";
	}
	const source = args.source_tag || ctx.taskId || ctx.threadId || "agent";
	const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
	const now = new Date().toISOString();

	// Determine tier: see `resolveTierForKey` for the priority rules.
	// Pinned-prefix keys always resolve to `pinned` regardless of the
	// explicit tier argument — this is the invariant that prevents
	// operational rules from being demoted by an `args.tier` on store.
	const resolvedTier = resolveTierForKey(key, args.tier);
	const isPinnedByPrefix = hasPinnedPrefix(key);

	// bun:sqlite .get() returns null (not undefined) when no row found
	const existing = ctx.db
		.prepare("SELECT id, deleted, tier FROM semantic_memory WHERE key = ?")
		.get(key) as { id: string; deleted: number; tier: MemoryTier } | null;

	if (existing) {
		// Updating existing entry: pinned prefixes always correct to "pinned", else preserve tier unless explicitly overridden
		const tierForUpdate = isPinnedByPrefix ? "pinned" : args.tier ? resolvedTier : existing.tier;
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

/**
 * Convert a user search query into FTS5 OR-joined terms.
 * Preserves quoted phrases and explicit operators (OR, AND, NOT).
 * Unquoted bare words are joined with OR for permissive matching.
 */
function toFts5OrQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed) return "";

	// If the query already contains explicit FTS5 operators, pass through as-is
	if (/\b(OR|AND|NOT)\b/.test(trimmed) || trimmed.includes('"')) {
		return trimmed;
	}

	// Split into tokens and join with OR for permissive matching
	const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return "";
	if (tokens.length === 1) return tokens[0];
	return tokens.join(" OR ");
}

function handleSearch(args: MemoryInput, ctx: ToolContext): string {
	const queryText = args.key;
	if (!queryText) {
		return "Error: search requires 'key' parameter";
	}

	const ftsQuery = toFts5OrQuery(queryText);
	if (!ftsQuery) {
		return `No memories matched: ${queryText}`;
	}

	// Use FTS5 full-text search with BM25 ranking.
	// FTS5 handles tokenization, stemming, and relevance scoring internally.
	try {
		const results = ctx.db
			.prepare(
				`SELECT m.key, m.value, m.source, m.modified_at
				 FROM semantic_memory_fts fts
				 JOIN semantic_memory m ON m.key = fts.key AND m.deleted = 0
				 WHERE semantic_memory_fts MATCH ?
				 ORDER BY fts.rank
				 LIMIT 20`,
			)
			.all(ftsQuery) as Array<{
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
	} catch {
		// FTS5 query syntax error (unbalanced quotes, etc.) — return no-match
		return `No memories matched: ${queryText}`;
	}
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
		// Per-action idempotency. search/traverse/neighbors are pure reads.
		// store/forget/connect/disconnect are state-mutating but idempotent
		// on (key, value) — overwriting with the same value or deleting an
		// already-deleted key is a no-op. The agent loop never mutates args
		// between retry attempts, so the (key, value) pair stays stable.
		resolveAnnotations: (args: Record<string, unknown>) => {
			switch (args.action) {
				case "search":
				case "traverse":
				case "neighbors":
					return { idempotent: true, readOnly: true };
				case "store":
				case "forget":
				case "connect":
				case "disconnect":
					return { idempotent: true, readOnly: false };
				default:
					return {};
			}
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
