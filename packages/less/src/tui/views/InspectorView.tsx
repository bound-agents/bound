import { readFileSync } from "node:fs";
import type { Message } from "@bound/shared";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import { SelectList } from "../components";
import { HighlightedLine, langFromPath } from "../components/HighlightedCode";
import { summarizeToolArgs } from "../components/MessageBlock";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { extractFullText, parseBlocks } from "../util/message-text";
import { tildifyPath } from "../util/path";
import { stripTerminalControlSequences } from "../util/terminal-control";
import { expandTabs, wrapLinesAtWidth } from "../util/wrap";
import { type ToolResultMeta, buildToolResultMetaMap } from "./ChatView";

/**
 * InspectorView — the transcript at full fidelity.
 *
 * Everything else in this TUI compresses: read/search runs collapse to one
 * line, tool results truncate to five, oversized outputs offload to disk and
 * leave a stub. That's the right default — but it means the committed
 * transcript is a summary, and sometimes the operator needs the primary
 * source. The inspector is the return path: a full-screen browser over every
 * message in the thread that renders the SELECTED message completely —
 * untruncated body, full tool arguments, and (for offloaded results) the
 * actual bytes re-read from the offload file, i.e. output even the model
 * never saw in full.
 *
 * Two levels:
 * - list: every message, newest first, one compact labelled row each
 * - detail: the selected message, scrollable, syntax-highlighted when the
 *   originating tool call carried a file path
 *
 * Esc walks back out (detail → list → close). Opened via `/inspect`.
 */

export interface InspectorViewProps {
	messages: Message[];
	onClose: () => void;
}

// Re-exported for consumers that treat the inspector as the home of
// full-fidelity extraction (tests, future callers).
export { extractFullText };

/**
 * Detect the oversized-result offload stub ("[Tool result offloaded: N
 * characters from "tool"] … saved to: <path>"). Returns the on-disk path so
 * the detail pane can hydrate the full output.
 */
export function resolveOffload(text: string): { chars: number; path: string } | null {
	const stub = text.match(/^\[Tool result offloaded: (\d+) characters from "[^"]+"\]/);
	if (!stub) return null;
	const pathMatch = text.match(/saved to:\s*(\S+)/);
	if (!pathMatch) return null;
	return { chars: Number.parseInt(stub[1], 10), path: pathMatch[1] };
}

export interface InspectorItem {
	msg: Message;
	glyph: string;
	color: string;
	/** UTC HH:MM:SS sliced straight from the ISO timestamp — deterministic. */
	time: string;
	label: string;
}

function firstNonEmptyLine(text: string): string {
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) return line.trim();
	}
	return "(empty)";
}

/** Build the list rows, newest first (inspection starts from "just now"). */
export function buildInspectorItems(
	messages: Message[],
	meta: Map<string, ToolResultMeta>,
): InspectorItem[] {
	const items: InspectorItem[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const time = msg.created_at.length >= 19 ? msg.created_at.slice(11, 19) : msg.created_at;
		const text = extractFullText(msg);
		if (msg.role === "tool_call") {
			// Label from the first tool_use block: name + first line of the
			// same args summary the transcript uses.
			const parsed = parseBlocks(msg.content);
			let label = firstNonEmptyLine(text);
			if (typeof parsed !== "string") {
				const use = parsed.find((b) => b.type === "tool_use");
				if (use && typeof use.name === "string") {
					const summary = summarizeToolArgs(use.name, (use.input ?? {}) as Record<string, unknown>);
					label = `${use.name} ${firstNonEmptyLine(summary)}`;
				}
			}
			items.push({ msg, glyph: "⏵", color: "cyan", time, label });
		} else if (msg.role === "tool_result") {
			const isError = msg.exit_code != null && msg.exit_code !== 0;
			const m = meta.get(msg.id);
			const lineCount = text.length === 0 ? 0 : text.split("\n").length;
			const name = m?.toolName ?? "(result)";
			items.push({
				msg,
				glyph: isError ? "✗" : "✓",
				color: isError ? "red" : "green",
				time,
				label: `${name} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`,
			});
		} else if (msg.role === "user") {
			items.push({ msg, glyph: "❯", color: "green", time, label: firstNonEmptyLine(text) });
		} else if (msg.role === "assistant") {
			items.push({ msg, glyph: "●", color: "white", time, label: firstNonEmptyLine(text) });
		} else {
			items.push({ msg, glyph: "◦", color: "gray", time, label: firstNonEmptyLine(text) });
		}
	}
	return items;
}

export interface InspectorDetail {
	title: string;
	body: string;
	lang?: string;
	/** Set when an offloaded result was re-read from disk. */
	hydratedFrom?: string;
	/** Set when the offload file existed in the stub but couldn't be read. */
	hydrateError?: string;
}

/**
 * Build the full-fidelity detail for one message. `readFile` is injectable
 * for tests; production uses readFileSync (offload files are host-local
 * temp files written by the same process family).
 */
export function buildInspectorDetail(
	item: InspectorItem,
	meta: Map<string, ToolResultMeta>,
	readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): InspectorDetail {
	const { msg } = item;
	let body = extractFullText(msg);
	let hydratedFrom: string | undefined;
	let hydrateError: string | undefined;

	const m = meta.get(msg.id);
	if (msg.role === "tool_result") {
		const offload = resolveOffload(body);
		if (offload) {
			try {
				body = readFile(offload.path);
				hydratedFrom = offload.path;
			} catch {
				hydrateError = `offload file unreadable: ${offload.path}`;
			}
		}
	}

	const roleName =
		msg.role === "tool_call" || msg.role === "tool_result"
			? `${msg.role}${m?.toolName ? ` · ${m.toolName}` : ""}`
			: msg.role;
	const lineCount = body.length === 0 ? 0 : body.split("\n").length;
	const exit =
		msg.role === "tool_result" && msg.exit_code != null && msg.exit_code !== 0
			? ` · exit ${msg.exit_code}`
			: "";
	return {
		title: `${roleName} · ${msg.created_at}${exit} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`,
		body: body.length === 0 ? "(empty)" : body,
		lang: m?.filePath ? langFromPath(m.filePath) : undefined,
		hydratedFrom,
		hydrateError,
	};
}

export function InspectorView({ messages, onClose }: InspectorViewProps): React.ReactElement {
	const { columns, rows } = useTerminalSize();
	const meta = useMemo(() => buildToolResultMetaMap(messages), [messages]);
	const items = useMemo(() => buildInspectorItems(messages, meta), [messages, meta]);
	const [selected, setSelected] = useState<InspectorItem | null>(null);
	const [scroll, setScroll] = useState(0);

	const detail = useMemo(
		() => (selected ? buildInspectorDetail(selected, meta) : null),
		[selected, meta],
	);

	// Wrap the body to the viewport width so scroll offsets are in PHYSICAL
	// rows — otherwise one long logical line could hide pages of content
	// behind a single scroll step.
	const bodyWidth = Math.max(20, columns - 6);
	const bodyLines = useMemo(() => {
		if (!detail) return [];
		const logical = stripTerminalControlSequences(detail.body)
			.split("\n")
			.map((l) => expandTabs(l));
		return wrapLinesAtWidth(logical, bodyWidth);
	}, [detail, bodyWidth]);

	// Chrome: border 2 + title 1 + detail header 1 + hydration note 1 +
	// scroll indicators 2 + key hints 1 + slack 1.
	const viewportRows = Math.max(4, rows - 9);
	const maxScroll = Math.max(0, bodyLines.length - viewportRows);

	useInput(
		(input, key) => {
			// List mode: SelectList owns navigation, Enter, and Esc (onCancel
			// → onClose). This handler only drives the detail pane.
			if (!selected) return;
			if (key.escape || input === "q") {
				setSelected(null);
				setScroll(0);
			} else if (key.upArrow) {
				setScroll((s) => Math.max(0, s - 1));
			} else if (key.downArrow) {
				setScroll((s) => Math.min(maxScroll, s + 1));
			} else if (key.pageUp) {
				setScroll((s) => Math.max(0, s - viewportRows));
			} else if (key.pageDown) {
				setScroll((s) => Math.min(maxScroll, s + viewportRows));
			} else if (input === "g") {
				setScroll(0);
			} else if (input === "G") {
				setScroll(maxScroll);
			}
		},
		{ isActive: true },
	);

	const visible = bodyLines.slice(scroll, scroll + viewportRows);
	const hiddenBelow = Math.max(0, bodyLines.length - scroll - visible.length);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
			<Text bold color="magenta">
				Inspector{selected ? "" : ` — ${items.length} messages`}
			</Text>
			{!selected ? (
				<>
					<SelectList
						items={items}
						onSelect={(it) => {
							setSelected(it);
							setScroll(0);
						}}
						onCancel={onClose}
						reservedRows={6}
						renderItem={(it, sel) => (
							<Text color={sel ? "magenta" : undefined} wrap="truncate-end">
								{sel ? "❯ " : "  "}
								<Text dimColor>{it.time} </Text>
								<Text color={it.color}>{it.glyph}</Text> {it.label}
							</Text>
						)}
					/>
					<Text dimColor>↑/↓ select · Enter open · Esc close</Text>
				</>
			) : detail ? (
				<>
					<Text wrap="truncate-end">
						<Text color={selected.color}>{selected.glyph}</Text> {detail.title}
					</Text>
					{detail.hydratedFrom && (
						<Text dimColor>
							hydrated from {tildifyPath(detail.hydratedFrom)} — full output, beyond what the model
							received
						</Text>
					)}
					{detail.hydrateError && <Text color="yellow">{detail.hydrateError}</Text>}
					{scroll > 0 && <Text color="gray">↑ {scroll} more</Text>}
					<Box flexDirection="column">
						{visible.map((line, i) => (
							<HighlightedLine
								key={`ln-${scroll + i}`}
								line={line.length === 0 ? " " : line}
								lang={detail.lang}
							/>
						))}
					</Box>
					{hiddenBelow > 0 && <Text color="gray">↓ {hiddenBelow} more</Text>}
					<Text dimColor>↑/↓ scroll · PgUp/PgDn page · g/G ends · Esc back</Text>
				</>
			) : null}
		</Box>
	);
}
