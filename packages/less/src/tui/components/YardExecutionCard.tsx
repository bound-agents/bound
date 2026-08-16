import { Text } from "ink";
import type React from "react";
import type { YardTreeSnapshot } from "../hooks/useYardExecutions";
import { StripeBox, formatDuration } from "./MessageBlock";

export interface YardExecutionCardProps {
	tree: YardTreeSnapshot;
	running?: boolean;
	/**
	 * Terminal width, threaded from ChatView like MessageBlock's
	 * `terminalColumns`. The wrapper NEEDS an explicit width: the previous
	 * rounded-border Box had none, so Yoga sized it to intrinsic content
	 * width and the terminal soft-wrapped the overflow at column 0 —
	 * shattering the border (screenshot regression, 2026-08-16). StripeBox's
	 * whole contract is that content wraps INSIDE the stripe when width is
	 * pinned.
	 */
	terminalColumns?: number;
}

/**
 * Yard's lifecycle events carry previews up to 4,000 chars INCLUDING
 * newlines (yard.ts `preview()`). The LIVE card renders in Ink's dynamic
 * region, where content taller than the terminal corrupts the repaint
 * (thread adb65d85, 2026-08-16) — so while `running`, every preview and
 * summary is clamped to one bounded line. The COMMITTED card renders once
 * into <Static> scrollback, where height is harmless, so it shows the full
 * previews (thread f1373e45: the flat 160-char elide hid the run's actual
 * input and result). Leaf summaries stay clamped on both — the full values
 * live in the persisted yard tool_call/tool_result rows.
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

/**
 * Elapsed ms between a node's lifecycle instants, when both have arrived.
 * Rendered with the same magnitude grading MessageBlock uses for tool
 * results — dim under 10s, yellow to a minute, red beyond — so the one slow
 * effect pops out of a wall of green rows without reading every number.
 */
function durationMs(started?: string, finished?: string): number | null {
	if (!started || !finished) return null;
	const ms = Date.parse(finished) - Date.parse(started);
	return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function DurationFragment({ ms }: { ms: number }): React.ReactElement {
	const color = ms >= 60_000 ? "red" : ms >= 10_000 ? "yellow" : undefined;
	return color ? (
		<Text color={color}> · {formatDuration(ms)}</Text>
	) : (
		<Text dimColor> · {formatDuration(ms)}</Text>
	);
}

/** State → color, used for glyphs and the header phase word. */
function phaseColor(phase: NodeState["phase"]): string {
	if (phase === "completed") return "green";
	if (phase === "failed") return "red";
	return "yellow";
}

/** Node kind → label color, so tool / inference / nested-run rows read apart. */
function kindColor(node: NodeState): string | undefined {
	switch (node.node.kind) {
		case "run":
			return "magenta";
		case "tool":
			return "cyan";
		case "inference":
			return "blue";
	}
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

/**
 * Renders a Yard execution tree as a transcript turn. Uses the SAME
 * StripeBox wrapper as message/alert blocks — a magenta left stripe with an
 * explicit width — instead of a bespoke bordered card, so long previews
 * wrap inside the stripe with the exact wrapping semantics every other
 * turn already has.
 */
export function YardExecutionCard({
	tree,
	running = false,
	terminalColumns = 80,
}: YardExecutionCardProps): React.ReactElement {
	const rows = flattenTree(tree);
	const effectCount = tree.nodes.filter((node) => node.node.kind !== "run").length;
	// Mirrors MessageBlock's stripeWidth computation so Yard turns align
	// with every other turn in the transcript.
	const stripeWidth = Math.max(20, terminalColumns - 1);
	// Live card: one bounded line per preview (dynamic-region height safety).
	// Committed card: full text, hard-wrapped by Ink inside the stripe.
	const preview = (text: string): string => (running ? clampLine(text) : text);
	const previewWrap = running ? ("truncate-end" as const) : ("wrap" as const);
	const treeMs = running ? null : durationMs(tree.startedAt, tree.finishedAt);
	return (
		<StripeBox color="magenta" width={stripeWidth}>
			<Text>
				<Text color="magenta" bold>
					Yard
				</Text>
				<Text dimColor> · </Text>
				<Text color={running ? "yellow" : phaseColor(tree.phase)}>
					{running ? "running" : tree.phase}
				</Text>
				<Text dimColor> · </Text>
				{effectCount} {effectCount === 1 ? "effect" : "effects"}
				{treeMs !== null ? <DurationFragment ms={treeMs} /> : null}
			</Text>
			{tree.inputPreview ? (
				<Text wrap={previewWrap}>
					<Text dimColor>input · </Text>
					{preview(tree.inputPreview)}
				</Text>
			) : null}
			{rows.map(({ node, prefix }) => {
				const ms = durationMs(node.startedAt, node.finishedAt);
				return (
					<Text key={node.id} wrap="truncate-end">
						<Text dimColor>{prefix}</Text>
						<Text color={phaseColor(node.phase)}>{glyph(node.phase)}</Text>{" "}
						<Text color={node.phase === "failed" ? "red" : kindColor(node)}>{label(node)}</Text>
						{ms !== null ? <DurationFragment ms={ms} /> : null}
						{node.summary ? <Text dimColor> · {clampLine(node.summary)}</Text> : null}
					</Text>
				);
			})}
			{!running && tree.resultPreview ? (
				<Text wrap={previewWrap}>
					<Text color="magenta">result · </Text>
					{preview(tree.resultPreview)}
				</Text>
			) : null}
		</StripeBox>
	);
}
