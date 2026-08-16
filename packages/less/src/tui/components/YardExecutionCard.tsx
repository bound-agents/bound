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

function label(node: YardTreeSnapshot["nodes"][number]): string {
	switch (node.node.kind) {
		case "run":
			return `run · depth ${node.node.depth}`;
		case "tool":
			return node.node.name;
		case "inference":
			return `infer · ${node.node.model}`;
	}
}

function glyph(phase: YardTreeSnapshot["nodes"][number]["phase"]): string {
	if (phase === "completed") return "✓";
	if (phase === "failed") return "✗";
	return "◌";
}

export function YardExecutionCard({
	tree,
	running = false,
}: YardExecutionCardProps): React.ReactElement {
	const leaves = tree.nodes.filter((node) => node.node.kind !== "run");
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
			<Text color="magenta" bold>
				Yard · {running ? "running" : tree.phase} · {leaves.length}{" "}
				{leaves.length === 1 ? "effect" : "effects"}
			</Text>
			{tree.inputPreview ? (
				<Text wrap="truncate-end">
					<Text dimColor>input · </Text>
					{clampLine(tree.inputPreview)}
				</Text>
			) : null}
			{leaves.map((node) => (
				<Text key={node.id} wrap="truncate-end" color={node.phase === "failed" ? "red" : undefined}>
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
