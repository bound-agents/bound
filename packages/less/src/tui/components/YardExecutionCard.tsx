import { Box, Text } from "ink";
import type React from "react";
import type { YardTreeSnapshot } from "../hooks/useYardExecutions";

export interface YardExecutionCardProps {
	tree: YardTreeSnapshot;
	running?: boolean;
}

/**
 * Yard's lifecycle events carry previews up to 4,000 chars INCLUDING
 * newlines (yard.ts `preview()`). Rendered raw, a long input made the live
 * card taller than the terminal and corrupted the Ink repaint (thread
 * adb65d85, 2026-08-16 — “cards badly broken… tied to certain input
 * lengths”). Every preview/summary is clamped to one bounded line: newline
 * runs collapse to a single space, and anything past the cap is elided.
 * The full values remain in the persisted yard tool_call/tool_result rows.
 */
const LINE_CLAMP = 160;

function clampLine(text: string): string {
	const flat = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
	if (flat.length <= LINE_CLAMP) return flat;
	return `${flat.slice(0, LINE_CLAMP - 1)}…`;
}

type NodeState = YardTreeSnapshot["nodes"][number];

function label(node: NodeState): string {
	switch (node.node.kind) {
		case "run":
			return `run · depth ${node.node.depth}`;
		case "tool":
			return node.node.name;
		case "inference":
			return `infer · ${node.node.model}`;
	}
}

function glyph(phase: NodeState["phase"]): string {
	if (phase === "completed") return "✓";
	if (phase === "failed") return "✗";
	return "◌";
}

interface TreeRow {
	node: NodeState;
	/** Box-drawing prefix (│ continuations + ├─/└─ branch), already indented. */
	prefix: string;
}

/**
 * Flatten the execution graph into display rows via depth-first walk from
 * the tree root. Children are ordered by startSeq (event arrival), so
 * concurrent siblings read in dispatch order. The tree ROOT run itself is
 * not emitted — the card header is that node; nested runs ARE emitted as
 * interior nodes with their subtrees indented beneath them.
 *
 * Defensive: nodes whose parent chain never reaches the root (out-of-order
 * delivery edge cases) are appended flat at the end rather than dropped,
 * so the card never silently hides work.
 */
function flattenTree(tree: YardTreeSnapshot): TreeRow[] {
	const childrenOf = new Map<string, NodeState[]>();
	for (const node of tree.nodes) {
		if (node.parentId === null) continue;
		const siblings = childrenOf.get(node.parentId);
		if (siblings) siblings.push(node);
		else childrenOf.set(node.parentId, [node]);
	}

	const rows: TreeRow[] = [];
	const visited = new Set<string>();
	const walk = (parentId: string, indent: string): void => {
		const children = childrenOf.get(parentId) ?? [];
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (visited.has(child.id)) continue;
			visited.add(child.id);
			const last = i === children.length - 1;
			rows.push({ node: child, prefix: `${indent}${last ? "└─" : "├─"} ` });
			walk(child.id, `${indent}${last ? "   " : "│  "}`);
		}
	};
	const root = tree.nodes.find((node) => node.parentId === null);
	if (root) {
		visited.add(root.id);
		walk(root.id, "");
	}
	for (const node of tree.nodes) {
		if (!visited.has(node.id)) rows.push({ node, prefix: "" });
	}
	return rows;
}

export function YardExecutionCard({
	tree,
	running = false,
}: YardExecutionCardProps): React.ReactElement {
	const rows = flattenTree(tree);
	const effectCount = tree.nodes.filter((node) => node.node.kind !== "run").length;
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
			<Text color="magenta" bold>
				Yard · {running ? "running" : tree.phase} · {effectCount}{" "}
				{effectCount === 1 ? "effect" : "effects"}
			</Text>
			{tree.inputPreview ? (
				<Text wrap="truncate-end">
					<Text dimColor>input · </Text>
					{clampLine(tree.inputPreview)}
				</Text>
			) : null}
			{rows.map(({ node, prefix }) => (
				<Text key={node.id} wrap="truncate-end" color={node.phase === "failed" ? "red" : undefined}>
					<Text dimColor>{prefix}</Text>
					{glyph(node.phase)} {label(node)}
					{node.summary ? <Text dimColor> · {clampLine(node.summary)}</Text> : null}
				</Text>
			))}
			{!running && tree.resultPreview ? (
				<Text wrap="truncate-end">
					<Text color="magenta">result · </Text>
					{clampLine(tree.resultPreview)}
				</Text>
			) : null}
		</Box>
	);
}
