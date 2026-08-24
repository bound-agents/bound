import type { YardTreeSnapshot } from "./yard-execution";

export interface YardAnchorTarget {
	key: string;
	toolCallIds: string[];
}

/** Anchors every tree for a call; unmatched trees remain trailing until messages catch up. */
export function anchorYardTrees(
	trees: YardTreeSnapshot[],
	targets: YardAnchorTarget[],
): { perItem: Map<string, YardTreeSnapshot[]>; trailing: YardTreeSnapshot[] } {
	const byCallId = new Map<string, YardTreeSnapshot[]>();
	for (const tree of trees) {
		if (!tree.toolCallId) continue;
		const group = byCallId.get(tree.toolCallId) ?? [];
		group.push(tree);
		byCallId.set(tree.toolCallId, group);
	}
	const perItem = new Map<string, YardTreeSnapshot[]>();
	const placed = new Set<string>();
	for (const target of targets) {
		const matched = target.toolCallIds.flatMap((id) => byCallId.get(id) ?? []);
		const unique = matched.filter((tree) => !placed.has(tree.traceId));
		for (const tree of unique) placed.add(tree.traceId);
		if (unique.length) perItem.set(target.key, unique);
	}
	return { perItem, trailing: trees.filter((tree) => !placed.has(tree.traceId)) };
}
