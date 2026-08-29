import { tokens } from "../theme";
import { formatYardValue } from "@bound/shared/yard-format";
import { Text } from "ink";
import type React from "react";
import type { YardTreeSnapshot } from "../hooks/useYardExecutions";
import { HighlightedCodeBlock } from "./HighlightedCode";
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
	/**
	 * Row budget for the graph section of a LIVE card. A scatter-gather run
	 * can carry dozens of aux nodes; rendered one-per-row the live card
	 * exceeded the terminal height and Ink's dynamic region flickered on
	 * every repaint (thread febfe45e, 2026-08-16). Rows past the budget
	 * collapse into one "… +N more effects" line. Committed cards ignore
	 * this — <Static> scrollback has no height constraint.
	 */
	maxGraphRows?: number;
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

/**
 * Rows of generator source shown on the LIVE card. The program is the best
 * signal of what a run is doing while it works, but the live card sits in
 * Ink's dynamic region where height is a budget — show the head and elide
 * the rest; the committed card renders the full source.
 */
const LIVE_PROGRAM_ROWS = 6;

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
	const color = ms >= 60_000 ? tokens.durationCritical : ms >= 10_000 ? tokens.durationCaution : undefined;
	return color ? (
		<Text color={color}> · {formatDuration(ms)}</Text>
	) : (
		<Text dimColor> · {formatDuration(ms)}</Text>
	);
}

/** State → color, used for glyphs and the header phase word. */
function phaseColor(phase: NodeState["phase"]): string {
	if (phase === "completed") return tokens.phaseCompleted;
	if (phase === "failed") return tokens.phaseFailed;
	return tokens.yardRunning;
}

/** Node kind → label color, so tool / inference / nested-run rows read apart. */
function kindColor(node: NodeState): string | undefined {
	switch (node.node.kind) {
		case "run":
			return tokens.nodeRun;
		case "tool":
			return tokens.nodeTool;
		case "inference":
			return tokens.nodeInference;
	}
}

/**
 * Same-label leaf siblings at or above this count pack into ONE dense row
 * (`label ×N` + a per-member glyph cluster in dispatch order). Scatter-
 * gather fan-outs dispatch the same aux specialist across every partition;
 * one row per member wasted the horizontal axis and grew the card vertically
 * without adding information (thread febfe45e).
 */
const GROUP_THRESHOLD = 3;

type DisplayRow =
	| { key: string; kind: "node"; node: NodeState; prefix: string }
	| { key: string; kind: "group"; nodes: NodeState[]; prefix: string; contPrefix: string }
	| { key: string; kind: "fail-detail"; node: NodeState; index: number; prefix: string }
	| { key: string; kind: "overflow"; count: number };

/**
 * Flatten the execution graph into display rows via depth-first walk from
 * the tree root. Children are ordered by startSeq (event arrival), so
 * concurrent siblings read in dispatch order. The tree ROOT run itself is
 * not emitted — the card header is that node; nested runs ARE emitted as
 * interior nodes with their subtrees indented beneath them.
 *
 * Leaf siblings sharing a label (the scatter-gather fan-out shape) pack
 * into one dense group row when the group reaches GROUP_THRESHOLD; failed
 * members with summaries keep an indexed detail row beneath the group so
 * the dense form never hides a failure reason.
 *
 * Defensive: nodes whose parent chain never reaches the root (out-of-order
 * delivery edge cases) are appended flat at the end rather than dropped,
 * so the card never silently hides work.
 */
function flattenTree(tree: YardTreeSnapshot): DisplayRow[] {
	const childrenOf = new Map<string, NodeState[]>();
	for (const node of tree.nodes) {
		if (node.parentId === null) continue;
		const siblings = childrenOf.get(node.parentId);
		if (siblings) siblings.push(node);
		else childrenOf.set(node.parentId, [node]);
	}

	const rows: DisplayRow[] = [];
	const visited = new Set<string>();

	const walk = (parentId: string, indent: string): void => {
		const children = (childrenOf.get(parentId) ?? []).filter((c) => !visited.has(c.id));

		// Group LEAF children by label; interior nodes always stay individual.
		const leafGroups = new Map<string, NodeState[]>();
		for (const child of children) {
			if (childrenOf.has(child.id)) continue;
			const lbl = label(child);
			const group = leafGroups.get(lbl);
			if (group) group.push(child);
			else leafGroups.set(lbl, [child]);
		}

		// Emit units in first-appearance order: interior nodes individually,
		// dense groups once at their first member's position, small groups as
		// individual rows.
		type Unit = { node?: NodeState; group?: NodeState[] };
		const units: Unit[] = [];
		const placedGroups = new Set<string>();
		for (const child of children) {
			if (childrenOf.has(child.id)) {
				units.push({ node: child });
				continue;
			}
			const lbl = label(child);
			const group = leafGroups.get(lbl) ?? [];
			if (group.length >= GROUP_THRESHOLD) {
				if (!placedGroups.has(lbl)) {
					placedGroups.add(lbl);
					units.push({ group });
				}
			} else {
				units.push({ node: child });
			}
		}

		units.forEach((unit, i) => {
			const last = i === units.length - 1;
			const branch = `${indent}${last ? "└─" : "├─"} `;
			const cont = `${indent}${last ? "   " : "│  "}`;
			if (unit.group) {
				for (const member of unit.group) visited.add(member.id);
				rows.push({
					key: `group:${unit.group[0].id}`,
					kind: "group",
					nodes: unit.group,
					prefix: branch,
					contPrefix: cont,
				});
				unit.group.forEach((member, idx) => {
					if (member.phase === "failed" && member.summary) {
						rows.push({
							key: `fail:${member.id}`,
							kind: "fail-detail",
							node: member,
							index: idx + 1,
							prefix: cont,
						});
					}
				});
			} else if (unit.node) {
				visited.add(unit.node.id);
				rows.push({ key: unit.node.id, kind: "node", node: unit.node, prefix: branch });
				walk(unit.node.id, cont);
			}
		});
	};

	const root = tree.nodes.find((node) => node.parentId === null);
	if (root) {
		visited.add(root.id);
		walk(root.id, "");
	}
	for (const node of tree.nodes) {
		if (!visited.has(node.id)) rows.push({ key: node.id, kind: "node", node, prefix: "" });
	}
	return rows;
}

/** min–max elapsed across group members that have both instants, or null. */
function groupDurationRange(nodes: NodeState[]): string | null {
	const values = nodes
		.map((node) => durationMs(node.startedAt, node.finishedAt))
		.filter((ms): ms is number => ms !== null);
	if (values.length === 0) return null;
	const min = Math.min(...values);
	const max = Math.max(...values);
	return min === max ? formatDuration(max) : `${formatDuration(min)}–${formatDuration(max)}`;
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
	maxGraphRows,
}: YardExecutionCardProps): React.ReactElement {
	let rows = flattenTree(tree);
	// Rows the live program section will consume (label + head + elide line),
	// charged against the graph budget so program + graph together never
	// outgrow the viewport (the febfe45e flicker class).
	const programLineCount = tree.programPreview ? tree.programPreview.split("\n").length : 0;
	const liveProgramRows =
		running && programLineCount > 0
			? 1 +
				Math.min(programLineCount, LIVE_PROGRAM_ROWS) +
				(programLineCount > LIVE_PROGRAM_ROWS ? 1 : 0)
			: 0;
	// Live-card height guard: cap the graph section so the dynamic region
	// never outgrows the viewport (constant-flicker regression, febfe45e).
	if (running && maxGraphRows !== undefined) {
		const budget = Math.max(1, maxGraphRows - liveProgramRows);
		if (rows.length > budget) {
			const keep = Math.max(1, budget - 1);
			const hidden = rows.length - keep;
			rows = [...rows.slice(0, keep), { key: "overflow", kind: "overflow", count: hidden }];
		}
	}
	const effectCount = tree.nodes.filter((node) => node.node.kind !== "run").length;
	// Mirrors MessageBlock's stripeWidth computation so Yard turns align
	// with every other turn in the transcript.
	const stripeWidth = Math.max(20, terminalColumns - 1);
	// Live card: one bounded line per preview (dynamic-region height safety).
	// Committed card: full text, hard-wrapped by Ink inside the stripe.
	const preview = (text: string): string => (running ? clampLine(text) : text);
	const previewWrap = running ? ("truncate-end" as const) : ("wrap" as const);
	const treeMs = running ? null : durationMs(tree.startedAt, tree.finishedAt);
	// Committed cards format payloads through the same formatter the web UI's
	// YardExecutionPanel uses (formatYardValue, #243): persistence envelopes
	// unwrap, sensitive reasoning fields sanitize away, object literals from
	// topology extraction render as JavaScript, and everything else that
	// parses renders as pretty JSON — so a Yard result reads identically in
	// both surfaces. Live cards keep one-line clamps (dynamic-region height
	// safety). A preview that yard.ts middle-elided no longer parses; the
	// formatter classifies it as a plain string and the caller falls back to
	// raw wrapped text — formatting is best-effort, never a gate on content.
	const formattedInput = !running && tree.inputPreview ? formatYardValue(tree.inputPreview) : null;
	const formattedResult =
		!running && tree.resultPreview ? formatYardValue(tree.resultPreview) : null;
	const formatLang = (f: { isJson: boolean; isJavaScript?: boolean }): string =>
		f.isJavaScript ? "javascript" : f.isJson ? "json" : "text";
	return (
		<StripeBox color={tokens.yardStripe} width={stripeWidth}>
			<Text>
				<Text color={tokens.yardStripe} bold>
					Yard
				</Text>
				<Text dimColor> · </Text>
				<Text color={running ? tokens.yardRunning : phaseColor(tree.phase)}>
					{running ? "running" : tree.phase}
				</Text>
				<Text dimColor> · </Text>
				{effectCount} {effectCount === 1 ? "effect" : "effects"}
				{treeMs !== null ? <DurationFragment ms={treeMs} /> : null}
			</Text>
			{tree.programPreview ? (
				running ? (
					<>
						<Text dimColor>program</Text>
						<HighlightedCodeBlock
							code={tree.programPreview.split("\n").slice(0, LIVE_PROGRAM_ROWS).join("\n")}
							lang="js"
						/>
						{tree.programPreview.split("\n").length > LIVE_PROGRAM_ROWS ? (
							<Text dimColor>
								… +{tree.programPreview.split("\n").length - LIVE_PROGRAM_ROWS} more lines
							</Text>
						) : null}
					</>
				) : (
					<>
						<Text dimColor>program</Text>
						<HighlightedCodeBlock
							code={tree.programPreview}
							lang="js"
							width={Math.max(10, stripeWidth - 2)}
						/>
					</>
				)
			) : null}
			{tree.inputPreview ? (
				running ||
				formattedInput === null ||
				(!formattedInput.isJson && !formattedInput.isJavaScript) ? (
					<Text wrap={previewWrap}>
						<Text dimColor>input · </Text>
						{preview(tree.inputPreview)}
					</Text>
				) : (
					<>
						<Text dimColor>input · {formattedInput.hint}</Text>
						<HighlightedCodeBlock
							code={formattedInput.display}
							lang={formatLang(formattedInput)}
							width={Math.max(10, stripeWidth - 2)}
						/>
					</>
				)
			) : null}
			{rows.map((row) => {
				if (row.kind === "overflow") {
					return (
						<Text key={row.key} dimColor>
							… +{row.count} more effects
						</Text>
					);
				}
				if (row.kind === "group") {
					const first = row.nodes[0];
					const range = groupDurationRange(row.nodes);
					return (
						<Text key={row.key} wrap="truncate-end">
							<Text dimColor>{row.prefix}</Text>
							<Text color={kindColor(first)}>{label(first)}</Text>
							<Text dimColor> ×{row.nodes.length} </Text>
							{row.nodes.map((member) => (
								<Text key={member.id} color={phaseColor(member.phase)}>
									{glyph(member.phase)}
								</Text>
							))}
							{range ? <Text dimColor> · {range}</Text> : null}
						</Text>
					);
				}
				if (row.kind === "fail-detail") {
					return (
						<Text key={row.key} wrap="truncate-end">
							<Text dimColor>{row.prefix}</Text>
							<Text color={tokens.phaseFailed}>✗ #{row.index}</Text>
							<Text dimColor> · {clampLine(row.node.summary ?? "")}</Text>
						</Text>
					);
				}
				const ms = durationMs(row.node.startedAt, row.node.finishedAt);
				return (
					<Text key={row.key} wrap="truncate-end">
						<Text dimColor>{row.prefix}</Text>
						<Text color={phaseColor(row.node.phase)}>{glyph(row.node.phase)}</Text>{" "}
						<Text color={row.node.phase === "failed" ? tokens.phaseFailed : kindColor(row.node)}>
							{label(row.node)}
						</Text>
						{ms !== null ? <DurationFragment ms={ms} /> : null}
						{row.node.summary ? <Text dimColor> · {clampLine(row.node.summary)}</Text> : null}
					</Text>
				);
			})}
			{!running && tree.resultPreview ? (
				formattedResult === null || (!formattedResult.isJson && !formattedResult.isJavaScript) ? (
					<Text wrap={previewWrap}>
						<Text color={tokens.yardStripe}>result · </Text>
						{preview(tree.resultPreview)}
					</Text>
				) : (
					<>
						<Text color={tokens.yardStripe}>result · {formattedResult.hint}</Text>
						<HighlightedCodeBlock
							code={formattedResult.display}
							lang={formatLang(formattedResult)}
							width={Math.max(10, stripeWidth - 2)}
						/>
						{formattedResult.tail ? <Text dimColor>{formattedResult.tail}</Text> : null}
					</>
				)
			) : null}
		</StripeBox>
	);
}
