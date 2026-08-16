import { Box, Text } from "ink";
import type React from "react";
import type { YardTreeSnapshot } from "../hooks/useYardExecutions";

export interface YardExecutionCardProps {
	tree: YardTreeSnapshot;
	running?: boolean;
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
				<Text>
					<Text dimColor>input · </Text>
					{tree.inputPreview}
				</Text>
			) : null}
			{leaves.map((node) => (
				<Text key={node.id} color={node.phase === "failed" ? "red" : undefined}>
					{glyph(node.phase)} {label(node)}
					{node.summary ? <Text dimColor> · {node.summary}</Text> : null}
				</Text>
			))}
			{!running && tree.resultPreview ? (
				<Text>
					<Text color="magenta">result · </Text>
					{tree.resultPreview}
				</Text>
			) : null}
		</Box>
	);
}
