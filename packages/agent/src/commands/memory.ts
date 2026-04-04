import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { removeEdges, upsertEdge } from "../graph-queries";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

// Positional arg mapping for the memory command:
// - connect:    source=src_key, target=tgt_key, relation=relation_type
// - disconnect: source=src_key, target=tgt_key, relation=optional_filter

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

export const memory: CommandDefinition = {
	name: "memory",
	args: [
		{ name: "subcommand", required: true, description: "Subcommand: connect, disconnect" },
		{ name: "source", required: false, description: "Source memory key" },
		{ name: "target", required: false, description: "Target memory key" },
		{ name: "relation", required: false, description: "Relation type" },
		{ name: "weight", required: false, description: "Edge weight (0-10, default 1.0)" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			switch (args.subcommand) {
				case "connect":
					return handleConnect(args, ctx);
				case "disconnect":
					return handleDisconnect(args, ctx);
				default:
					return commandError(
						`unknown subcommand: ${args.subcommand}. Available: connect, disconnect`,
					);
			}
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
