import { insertRow, softDelete, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { cascadeDeleteEdges, getNeighbors, removeEdges, traverseGraph, upsertEdge } from "../graph-queries";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

// Positional arg mapping for the memory command (args are Record<string, string>):
// - store:      source=key, target=value, source_tag=provenance
// - forget:     source=key, prefix=prefix_filter
// - search:     source=query_text
// - connect:    source=src_key, target=tgt_key, relation=relation_type
// - disconnect: source=src_key, target=tgt_key, relation=optional_filter
// - traverse:   source=start_key, depth=max_depth, relation=optional_filter
// - neighbors:  source=key, dir=direction_filter

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

function handleStore(args: Record<string, string>, ctx: CommandContext) {
	const key = args.key || args.source; // 'source' positional becomes 'key' in subcommand context
	const value = args.value || args.target; // positional mapping
	if (!key || !value) {
		return commandError("usage: memory store <key> <value> [--source_tag S]");
	}
	const source = args.source_tag || ctx.taskId || ctx.threadId || "agent";
	const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
	const now = new Date().toISOString();

	// bun:sqlite .get() returns null (not undefined) when no row found.
	// Note: The existing memorize.ts incorrectly typed .get() as `| undefined`.
	// We correct this to `| null` per the bun:sqlite invariant documented in CLAUDE.md.
	const existing = ctx.db
		.prepare("SELECT id, deleted FROM semantic_memory WHERE key = ?")
		.get(key) as { id: string; deleted: number } | null;

	if (existing) {
		updateRow(
			ctx.db,
			"semantic_memory",
			memoryId,
			{ value, source, last_accessed_at: now, deleted: 0 },
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
			},
			ctx.siteId,
		);
	}

	return commandSuccess(`Memory saved: ${key}\n`);
}

function handleForget(args: Record<string, string>, ctx: CommandContext) {
	if (args.prefix) {
		const prefix = args.prefix;
		const entries = ctx.db
			.prepare("SELECT id, key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
			.all(`${prefix}%`) as Array<{ id: string; key: string }>;

		if (entries.length === 0) {
			return commandSuccess(`No memories found with prefix: ${prefix}\n`);
		}

		let totalEdges = 0;
		for (const entry of entries) {
			softDelete(ctx.db, "semantic_memory", entry.id, ctx.siteId);
			totalEdges += cascadeDeleteEdges(ctx.db, entry.key, ctx.siteId);
		}

		return commandSuccess(
			`Deleted ${entries.length} memories with prefix: ${prefix}${totalEdges > 0 ? ` (${totalEdges} edge(s) also removed)` : ""}\n`,
		);
	}

	const key = args.key || args.source; // positional mapping
	if (!key) {
		return commandError("usage: memory forget <key> [--prefix P]");
	}

	const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
	// bun:sqlite .get() returns null (not undefined) when no row found
	const existing = ctx.db
		.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(key) as { id: string } | null;

	if (!existing) {
		return commandError(`Memory not found: ${key}`);
	}

	softDelete(ctx.db, "semantic_memory", memoryId, ctx.siteId);

	// Cascade: soft-delete all edges referencing this key (as source or target)
	const edgesCascaded = cascadeDeleteEdges(ctx.db, key, ctx.siteId);

	return commandSuccess(
		`Memory deleted: ${key}${edgesCascaded > 0 ? ` (${edgesCascaded} edge(s) also removed)` : ""}\n`,
	);
}

function handleSearch(args: Record<string, string>, ctx: CommandContext) {
	const queryText = args.query || args.source; // positional mapping
	if (!queryText) {
		return commandError("usage: memory search <query>");
	}

	const keywords = queryText
		.toLowerCase()
		.replace(/[^a-z0-9_\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

	if (keywords.length === 0) {
		return commandSuccess("No searchable keywords found in query.\n");
	}

	const likeConditions = keywords.map(
		() => "(LOWER(key) LIKE '%' || ? || '%' OR LOWER(value) LIKE '%' || ? || '%')",
	);
	const params = keywords.flatMap((kw) => [kw, kw]);

	const results = ctx.db
		.prepare(
			`SELECT key, value, source, modified_at FROM semantic_memory
             WHERE deleted = 0 AND (${likeConditions.join(" OR ")})
             ORDER BY modified_at DESC LIMIT 20`,
		)
		.all(...params) as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
	}>;

	if (results.length === 0) {
		return commandSuccess(`No memories matched: ${queryText}\n`);
	}

	const lines = results.map(
		(r) =>
			`- ${r.key}: ${r.value.substring(0, 100)}${r.value.length > 100 ? "..." : ""} [${r.source || "unknown"}]`,
	);
	return commandSuccess(`Found ${results.length} memories:\n${lines.join("\n")}\n`);
}

function handleConnect(args: Record<string, string>, ctx: CommandContext) {
	const src = args.source;
	const tgt = args.target;
	const rel = args.relation;
	const weight = args.weight ? Number.parseFloat(args.weight) : 1.0;

	if (!src || !tgt || !rel) {
		return commandError("usage: memory connect <source> <target> <relation> [--weight N]");
	}

	if (Number.isNaN(weight) || weight < 0 || weight > 10) {
		return commandError("weight must be a number between 0 and 10");
	}

	// Validate both memory keys exist (active, not soft-deleted)
	const srcExists = ctx.db
		.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(src);
	if (!srcExists) {
		return commandError(`source memory not found: ${src}`);
	}

	const tgtExists = ctx.db
		.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(tgt);
	if (!tgtExists) {
		return commandError(`target memory not found: ${tgt}`);
	}

	const id = upsertEdge(ctx.db, src, tgt, rel, weight, ctx.siteId);
	return commandSuccess(`Edge created: ${src} --[${rel}]--> ${tgt} (weight=${weight}, id=${id})\n`);
}

function handleDisconnect(args: Record<string, string>, ctx: CommandContext) {
	const src = args.source;
	const tgt = args.target;
	const rel = args.relation || undefined;

	if (!src || !tgt) {
		return commandError("usage: memory disconnect <source> <target> [relation]");
	}

	const count = removeEdges(ctx.db, src, tgt, rel, ctx.siteId);
	if (count === 0) {
		return commandError(
			`no edges found between ${src} and ${tgt}${rel ? ` with relation ${rel}` : ""}`,
		);
	}

	return commandSuccess(`Removed ${count} edge(s) between ${src} and ${tgt}\n`);
}

function handleTraverse(args: Record<string, string>, ctx: CommandContext) {
	const key = args.source; // first positional arg
	if (!key) {
		return commandError("usage: memory traverse <key> [--depth N] [--relation R]");
	}

	const depth = args.depth ? Number.parseInt(args.depth, 10) : 2;
	const relation = args.relation || undefined;

	if (Number.isNaN(depth) || depth < 1) {
		return commandError("depth must be a positive integer (1-3)");
	}

	const results = traverseGraph(ctx.db, key, depth, relation);

	if (results.length === 0) {
		return commandSuccess(`No connected entries found from: ${key}\n`);
	}

	const lines = results.map(
		(r) =>
			`${"  ".repeat(r.depth)}${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [depth ${r.depth}, ${r.viaRelation}]`,
	);
	return commandSuccess(
		`Graph traversal from ${key} (depth=${Math.min(depth, 3)}, ${results.length} entries):\n${lines.join("\n")}\n`,
	);
}

function handleNeighbors(args: Record<string, string>, ctx: CommandContext) {
	const key = args.source; // first positional arg
	if (!key) {
		return commandError("usage: memory neighbors <key> [--dir out|in|both]");
	}

	const dir = (args.dir as "out" | "in" | "both") || "both";
	if (!["out", "in", "both"].includes(dir)) {
		return commandError("dir must be one of: out, in, both");
	}

	const results = getNeighbors(ctx.db, key, dir);

	if (results.length === 0) {
		return commandSuccess(`No neighbors found for: ${key}\n`);
	}

	const lines = results.map(
		(r) =>
			`  ${r.direction === "out" ? "-->" : "<--"} ${r.key}: ${r.value.substring(0, 80)}${r.value.length > 80 ? "..." : ""} [${r.relation}, w=${r.weight}]`,
	);
	return commandSuccess(
		`Neighbors of ${key} (${results.length} connections):\n${lines.join("\n")}\n`,
	);
}

export const memory: CommandDefinition = {
	name: "memory",
	args: [
		{
			name: "subcommand",
			required: true,
			description: "Subcommand: store, forget, search, connect, disconnect, traverse, neighbors",
		},
		{ name: "source", required: false, description: "First positional arg (key/source_key/query)" },
		{ name: "target", required: false, description: "Second positional arg (value/target_key)" },
		{ name: "relation", required: false, description: "Relation type (for connect/disconnect)" },
		{ name: "weight", required: false, description: "Edge weight (for connect)" },
		{ name: "prefix", required: false, description: "Prefix for batch forget" },
		{ name: "source_tag", required: false, description: "Source tag for store provenance" },
		{ name: "depth", required: false, description: "Traversal depth (1-3, default 2)" },
		{ name: "dir", required: false, description: "Neighbor direction: out, in, or both" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			switch (args.subcommand) {
				case "store":
					return handleStore(args, ctx);
				case "forget":
					return handleForget(args, ctx);
				case "search":
					return handleSearch(args, ctx);
				case "connect":
					return handleConnect(args, ctx);
				case "disconnect":
					return handleDisconnect(args, ctx);
				case "traverse":
					return handleTraverse(args, ctx);
				case "neighbors":
					return handleNeighbors(args, ctx);
				default:
					return commandError(
						`unknown subcommand: ${args.subcommand}. Available: store, forget, search, connect, disconnect, traverse, neighbors`,
					);
			}
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
