import { Box, Text, useInput, useStdin } from "ink";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { expandTabs } from "../util/wrap";

export interface SlashCompletion {
	/** The command literal, including the leading slash (e.g. "/model"). */
	value: string;
	/** One-line description shown dimmed beside the command in the menu. */
	description?: string;
	/** When true, Tab-completion appends a trailing space so the operator
	 *  can keep typing the argument without an extra keystroke. */
	takesArgs?: boolean;
}

export interface TextInputProps {
	onSubmit: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	/** Available columns for text. When set, the component renders explicit
	 *  line breaks at column boundaries instead of relying on terminal
	 *  wrapping. This ensures Ink's logical line count matches the physical
	 *  row count, preventing ghost lines when the input height changes. */
	columns?: number;
	/** Whether the input currently holds keyboard focus. Defaults to true. Set
	 *  false while a key-capturing overlay is mounted above the input (e.g. a
	 *  dismissable banner that closes on 'x') so the overlay steals focus —
	 *  otherwise ink delivers the keypress to BOTH handlers and the dismiss key
	 *  also lands as a character in the input. Suppresses both keystroke capture
	 *  and the imperative clear; distinct from `disabled` (connection state),
	 *  which also dims the rendered value. */
	hasFocus?: boolean;
	/** Prior submissions, oldest → newest. ↑/↓ (or Ctrl+P/N) recall them
	 *  readline-style: ↑ walks back, ↓ walks forward and finally restores the
	 *  in-progress draft. Recalled text passes through the same sanitation as
	 *  a paste (tabs → spaces, newlines → spaces) so a multi-line historical
	 *  message can't desync the input's physical-row accounting. Any edit
	 *  detaches from history and keeps the recalled text. */
	history?: string[];
	/** Slash-command palette. While the buffer is a bare "/token" (no space
	 *  yet), prefix-matching entries render as a menu under the input:
	 *  ↑/↓ select, Tab completes into the buffer, Enter submits the selected
	 *  command directly. */
	completions?: SlashCompletion[];
}

/**
 * Break a string into lines of at most `cols` characters each, preferring
 * word-boundary breaks (last space at or before the column limit). Falls back
 * to a hard character break when no space exists in the window (for long words
 * that exceed the column width). The trailing space of a word is included in
 * the current line so every character in `value` maps to exactly one position
 * in the returned lines — this keeps cursor arithmetic correct.
 * Exported for testing.
 */
export function breakLines(value: string, cols: number): string[] {
	if (value.length === 0) return [""];
	const lines: string[] = [];
	let start = 0;

	while (start < value.length) {
		const remaining = value.length - start;
		if (remaining <= cols) {
			lines.push(value.slice(start));
			break;
		}

		// Find the last space within the first `cols` characters.
		// Including the space in the current line keeps the character-position
		// mapping simple for findCursorInLines().
		let breakAt = -1;
		for (let i = start + cols - 1; i >= start; i--) {
			if (value[i] === " ") {
				breakAt = i + 1; // include the space in this line
				break;
			}
		}

		if (breakAt === -1) {
			// No space found — hard break at column boundary (long word case).
			lines.push(value.slice(start, start + cols));
			start += cols;
		} else {
			lines.push(value.slice(start, breakAt));
			start = breakAt;
		}
	}

	return lines;
}

/**
 * Given the lines produced by breakLines() and a cursor position `pos` in the
 * original string, returns the (line index, column within that line) pair for
 * the cursor. Works correctly when lines have different lengths (word-boundary
 * breaks produce variable-length lines, so the old `Math.floor(pos / cols)`
 * arithmetic is wrong).
 * Exported for testing.
 */
export function findCursorInLines(
	lines: string[],
	pos: number,
): { cursorLine: number; cursorCol: number } {
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const lineEnd = offset + lines[i].length;
		if (pos < lineEnd || i === lines.length - 1) {
			return { cursorLine: i, cursorCol: pos - offset };
		}
		offset = lineEnd;
	}
	return { cursorLine: lines.length - 1, cursorCol: lines[lines.length - 1].length };
}

/**
 * Grapheme-cluster-aware cursor arithmetic.
 *
 * A cursor position is a JS string index in [0, value.length] that sits ON
 * a grapheme-cluster boundary. Moving by one character means advancing to
 * the next boundary, not to `pos + 1`. This matters for:
 *   - Emoji built from multiple code points (🏳️‍🌈 is 6 code units / 4 code points).
 *   - Regional-indicator flag pairs (🇯🇵 is 2 code points / 4 code units).
 *   - Combining marks (e + ́ renders as é but is 2 code units).
 *
 * We compute the boundary list lazily per keystroke. For typical chat
 * input (tens to hundreds of characters) the cost is negligible; if this
 * ever shows up in a profile we can memoize by `value`.
 */
const segmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

function graphemeBoundaries(value: string): number[] {
	if (value.length === 0) {
		return [0];
	}
	if (!segmenter) {
		// Fallback: every code-unit index is a "boundary". This degrades to
		// the pre-Segmenter behavior on runtimes without Intl.Segmenter.
		const out: number[] = [];
		for (let i = 0; i <= value.length; i++) out.push(i);
		return out;
	}
	const out: number[] = [0];
	for (const seg of segmenter.segment(value)) {
		out.push(seg.index + seg.segment.length);
	}
	return out;
}

/**
 * Move cursor one grapheme cluster to the left of `pos`.
 * Returns the largest boundary strictly less than `pos`, clamped to 0.
 */
function graphemeLeft(value: string, pos: number): number {
	if (pos <= 0) return 0;
	const boundaries = graphemeBoundaries(value);
	let prev = 0;
	for (const b of boundaries) {
		if (b >= pos) return prev;
		prev = b;
	}
	return prev;
}

/**
 * Move cursor one grapheme cluster to the right of `pos`.
 * Returns the smallest boundary strictly greater than `pos`, clamped to
 * value.length.
 */
function graphemeRight(value: string, pos: number): number {
	if (pos >= value.length) return value.length;
	const boundaries = graphemeBoundaries(value);
	for (const b of boundaries) {
		if (b > pos) return b;
	}
	return value.length;
}

/**
 * Return the grapheme cluster that contains `pos` (i.e. the cluster whose
 * range is [prevBoundary, nextBoundary)), or null if pos is at end-of-string.
 * Used for rendering the character under the cursor.
 */
function graphemeAt(value: string, pos: number): string | null {
	if (pos >= value.length) return null;
	const boundaries = graphemeBoundaries(value);
	for (let i = 0; i < boundaries.length - 1; i++) {
		if (boundaries[i] <= pos && pos < boundaries[i + 1]) {
			return value.slice(boundaries[i], boundaries[i + 1]);
		}
	}
	// Shouldn't reach here for a valid pos < length.
	return value[pos] ?? null;
}

/**
 * Word boundary helpers for Option/Alt+Arrow navigation.
 * A "word" is a maximal run of non-whitespace characters. Whitespace is
 * ASCII-plus-unicode-space, all single-codepoint in practice, so we can
 * still walk this one JS index at a time.
 *
 * Behavior matches common terminal/readline conventions:
 * - Option+Left: jump to the start of the current or previous word.
 * - Option+Right: jump past the end of the current or next word.
 */
function wordLeft(value: string, pos: number): number {
	let i = pos;
	// Skip whitespace immediately to the left.
	while (i > 0 && /\s/.test(value[i - 1] ?? "")) {
		i--;
	}
	// Skip the word characters.
	while (i > 0 && !/\s/.test(value[i - 1] ?? "")) {
		i--;
	}
	return i;
}

function wordRight(value: string, pos: number): number {
	let i = pos;
	const len = value.length;
	// Skip whitespace immediately to the right.
	while (i < len && /\s/.test(value[i] ?? "")) {
		i++;
	}
	// Skip the word characters.
	while (i < len && !/\s/.test(value[i] ?? "")) {
		i++;
	}
	return i;
}

/** Recalled history entries pass through the same sanitation as a paste:
 * tabs → spaces, embedded newlines → single spaces — a multi-line historical
 * message must not desync the input's physical-row accounting. */
function sanitizeRecall(s: string): string {
	return expandTabs(s).replace(/\r\n|\r|\n/g, " ");
}

export function TextInput({
	onSubmit,
	placeholder = "",
	disabled = false,
	columns,
	hasFocus = true,
	history = [],
	completions = [],
}: TextInputProps): React.ReactElement {
	// Combine value + cursor position in a single state atom so that
	// rapid-fire keystrokes (which all close over the same render's state)
	// don't see a stale cursor position. Using two separate useState hooks
	// caused reversed character order when two keys arrived within one
	// render cycle (input events fire synchronously; React batches the
	// setters but the next handler still reads the captured `pos`).
	const [state, setState] = useState<{ value: string; pos: number }>({
		value: "",
		pos: 0,
	});
	const { value, pos } = state;

	// --- Slash-command completion menu (derived) ---
	// Active only while the buffer is a bare "/token" — the moment a space
	// lands (arguments begin) the menu folds away and every key reverts to
	// its plain meaning.
	const slashFilter = /^\/\S*$/.test(value) ? value : null;
	const menuItems =
		slashFilter !== null ? completions.filter((c) => c.value.startsWith(slashFilter)) : [];
	const menuActive = menuItems.length > 0 && !disabled && hasFocus;
	// Selection is keyed to the filter it was made under: when the filter
	// changes (typing narrows/widens the match list) the stored index no
	// longer applies and the selection derives back to 0 — no reset effect
	// needed. The clamp also covers a shrinking list under the same filter.
	const [menuState, setMenuState] = useState<{ idx: number; filter: string | null }>({
		idx: 0,
		filter: null,
	});
	const menuSel =
		menuState.filter === slashFilter
			? Math.min(menuState.idx, Math.max(0, menuItems.length - 1))
			: 0;

	// --- History recall state ---
	// idx === null: not browsing. draft: the in-progress text saved when ↑
	// first entered history, restored when ↓ walks past the newest entry.
	const [hist, setHist] = useState<{ idx: number | null; draft: string }>({
		idx: null,
		draft: "",
	});

	// Any edit detaches from history browsing and keeps the current text —
	// otherwise a recalled entry silently shadows the characters just typed.
	const detachHistory = useCallback(() => {
		setHist((h) => (h.idx === null ? h : { idx: null, draft: "" }));
	}, []);

	// Mirror the live value/disabled into refs so clear() (whose identity must
	// stay stable across renders) reads current state rather than a stale
	// capture.
	const valueRef = useRef(value);
	valueRef.current = value;
	const disabledRef = useRef(disabled);
	disabledRef.current = disabled;
	const hasFocusRef = useRef(hasFocus);
	hasFocusRef.current = hasFocus;

	// Single-press Esc clear. No-op on an empty buffer; a modal capturing input
	// above us (hasFocus=false) makes this a no-op so the input never edits
	// itself while it lacks focus.
	const clear = useCallback((): boolean => {
		if (disabledRef.current || !hasFocusRef.current) return false;
		if (valueRef.current.length === 0) return false;
		setState({ value: "", pos: 0 });
		setHist({ idx: null, draft: "" });
		return true;
	}, []);
	// ink maps BOTH 0x7F (the byte the Unix Backspace key sends) and the
	// xterm forward-delete escape sequence (ESC[3~) to key.delete=true with
	// input='' (see ink's parse-keypress.js: 0x7F and ESC[3~ both resolve to
	// name 'delete'), so the two keys are indistinguishable from the useInput
	// API alone. To recover which physical key was pressed we tap ink's
	// internal event emitter, which emits the raw input chunk on its 'input'
	// event — ink's App.handleReadable does
	// `internal_eventEmitter.emit('input', chunk)` right alongside the parse
	// that drives useInput. prependListener guarantees our handler runs BEFORE
	// useInput's own 'input' listener, so lastRawBytes already reflects the
	// current keypress by the time the useInput callback inspects it. This
	// works identically under a real TTY and ink-testing-library, and unlike a
	// stdin 'data' tap it never flips stdin into flowing mode (ink consumes
	// stdin via 'readable' + read()).
	const lastRawBytes = useRef<string>("");
	const { internal_eventEmitter: inputEmitter } = useStdin();
	useEffect(() => {
		const handler = (data: Buffer | string) => {
			lastRawBytes.current = typeof data === "string" ? data : data.toString("utf8");
		};
		inputEmitter.prependListener("input", handler);
		return () => {
			inputEmitter.removeListener("input", handler);
		};
	}, [inputEmitter]);

	useInput(
		(input, key) => {
			if (disabled) {
				return;
			}

			// --- Navigation keys (must be checked BEFORE the meta/ctrl swallow,
			// because Option+Arrow on macOS arrives as meta === true). ---

			if (key.leftArrow) {
				if (key.meta || key.ctrl) {
					// Option/Alt+Left (macOS) or Ctrl+Left (Linux): word jump left
					setState((s) => ({ ...s, pos: wordLeft(s.value, s.pos) }));
				} else {
					setState((s) => ({ ...s, pos: graphemeLeft(s.value, s.pos) }));
				}
				return;
			}

			if (key.rightArrow) {
				if (key.meta || key.ctrl) {
					setState((s) => ({ ...s, pos: wordRight(s.value, s.pos) }));
				} else {
					setState((s) => ({ ...s, pos: graphemeRight(s.value, s.pos) }));
				}
				return;
			}

			// Up/Down: menu selection while the completion menu is open; history
			// recall otherwise (Ctrl+P/N are the readline aliases). ↓ past the
			// newest entry restores the draft that ↑ interrupted.
			if (key.upArrow || (key.ctrl && input === "p")) {
				if (menuActive) {
					setMenuState({
						idx: (menuItems.length + menuSel - 1) % menuItems.length,
						filter: slashFilter,
					});
					return;
				}
				if (history.length === 0) return;
				const nextIdx = hist.idx === null ? history.length - 1 : Math.max(0, hist.idx - 1);
				const draft = hist.idx === null ? value : hist.draft;
				const recalled = sanitizeRecall(history[nextIdx] ?? "");
				setHist({ idx: nextIdx, draft });
				setState({ value: recalled, pos: recalled.length });
				return;
			}
			if (key.downArrow || (key.ctrl && input === "n")) {
				if (menuActive) {
					setMenuState({ idx: (menuSel + 1) % menuItems.length, filter: slashFilter });
					return;
				}
				if (hist.idx === null) return;
				if (hist.idx >= history.length - 1) {
					const draft = hist.draft;
					setHist({ idx: null, draft: "" });
					setState({ value: draft, pos: draft.length });
				} else {
					const nextIdx = hist.idx + 1;
					const recalled = sanitizeRecall(history[nextIdx] ?? "");
					setHist((h) => ({ ...h, idx: nextIdx }));
					setState({ value: recalled, pos: recalled.length });
				}
				return;
			}

			// ESC+b / ESC+f: readline word-left / word-right. macOS Option+Arrow
			// sends these in most terminals. Ink parses them as meta + 'b'/'f'
			// (not as leftArrow/rightArrow), so they need separate handling.
			if (key.meta && input === "b") {
				setState((s) => ({ ...s, pos: wordLeft(s.value, s.pos) }));
				return;
			}
			if (key.meta && input === "f") {
				setState((s) => ({ ...s, pos: wordRight(s.value, s.pos) }));
				return;
			}

			// Ctrl+A / Ctrl+E: jump to start/end (readline convention).
			if (key.ctrl && input === "a") {
				setState((s) => ({ ...s, pos: 0 }));
				return;
			}
			if (key.ctrl && input === "e") {
				setState((s) => ({ ...s, pos: s.value.length }));
				return;
			}

			// Tab: complete the selected menu entry into the buffer. Swallowed
			// even with no menu open — a literal tab keypress in a single-line
			// input is never intent (tabs in PASTED text are sanitized to spaces
			// by the character-input branch below, unchanged).
			if (key.tab) {
				if (menuActive) {
					const chosen = menuItems[menuSel];
					const completed = chosen.takesArgs ? `${chosen.value} ` : chosen.value;
					setState({ value: completed, pos: completed.length });
				}
				return;
			}

			// --- Editing keys ---

			if (key.return) {
				// With the menu open, Enter runs the SELECTED command — the buffer
				// may only hold "/mo" but the operator's intent is the highlighted
				// "/model".
				onSubmit(menuActive ? menuItems[menuSel].value : value);
				setState({ value: "", pos: 0 });
				setHist({ idx: null, draft: "" });
				return;
			}

			if (key.delete) {
				// Disambiguate via raw bytes (see useEffect tap above).
				// Real forward Delete sends one of these escape sequences:
				//   ESC[3~  (plain), ESC[3 followed by dollar (shift),
				//   ESC[3^  (ctrl).
				// Anything else (DEL 0x7F, ESC+DEL) is the Unix Backspace
				// key, which ink unhelpfully labels 'delete' too.
				const raw = lastRawBytes.current;
				const isForwardDelete =
					raw === "\u001b[3~" || raw === "\u001b[3\u0024" || raw === "\u001b[3^";
				if (isForwardDelete) {
					// Delete the grapheme cluster AT the cursor (forward delete).
					setState((s) => {
						if (s.pos >= s.value.length) {
							return s;
						}
						const nextPos = graphemeRight(s.value, s.pos);
						return {
							value: s.value.slice(0, s.pos) + s.value.slice(nextPos),
							pos: s.pos,
						};
					});
					detachHistory();
					return;
				}
				// Fall through: treat as backspace.
			}

			if (key.backspace || key.delete) {
				// Delete the grapheme cluster before the cursor (may be more
				// than one JS code unit for emoji/flags/combining marks).
				setState((s) => {
					if (s.pos <= 0) {
						return s;
					}
					const newPos = graphemeLeft(s.value, s.pos);
					return {
						value: s.value.slice(0, newPos) + s.value.slice(s.pos),
						pos: newPos,
					};
				});
				detachHistory();
				return;
			}

			// Esc clears the buffer (single press, no-op when empty). Bare ESC
			// only — escape *sequences* (arrows, meta-combos) were consumed by the
			// branches above, so key.escape here means the lone byte.
			if (key.escape) {
				clear();
				return;
			}

			// Swallow any remaining control sequences.
			if (key.ctrl || key.meta) {
				return;
			}

			// --- Character input ---
			if (input && input.length > 0) {
				// Filter out mouse escape sequences that leak through Ink's parser.
				if (input.startsWith("[<") || input.startsWith("[M")) {
					return;
				}
				// Sanitize pasted text: breakLines does its row accounting in plain
				// character counts, but a literal tab renders as up to 8 columns and
				// an embedded newline as a whole extra physical row — either desyncs
				// Ink's logical line count from the physical rows, making log-update
				// under-erase and re-emit the input box's top border on every
				// keystroke. Tabs become spaces; newlines (multiline paste into a
				// single-line input) become single spaces.
				const sanitized = expandTabs(input).replace(/\r\n|\r|\n/g, " ");
				setState((s) => ({
					value: s.value.slice(0, s.pos) + sanitized + s.value.slice(s.pos),
					pos: s.pos + sanitized.length,
				}));
				detachHistory();
			}
		},
		{ isActive: !disabled && hasFocus },
	);

	// Render the value with the cursor drawn ON TOP OF the grapheme cluster
	// at `pos` (via inverse video), rather than INSERTED between characters.
	// This keeps column positions stable as the cursor moves, and renders
	// multi-codepoint graphemes (emoji, flags, combining marks) as a single
	// unit under the cursor instead of half-glyphs.
	//
	// At end-of-string (pos === value.length), the cursor is rendered as a
	// trailing inverse-video space so it remains visible.

	// --- Completion menu node ---
	// Rendered UNDER the value line(s). Hard row cap keeps the dynamic
	// region's height predictable (the ghost-card lesson: unbounded physical
	// rows in the live area make log-update strand scrollback copies). Eight
	// rows covers the full command palette today; a longer list truncates
	// (selection can't walk past it — prefix filtering shrinks the list
	// faster than ↓ can chase it in practice).
	const MENU_MAX_ITEMS = 8;
	const menuNode = menuActive ? (
		<Box flexDirection="column">
			{menuItems.slice(0, MENU_MAX_ITEMS).map((c, i) => (
				<Text key={c.value} wrap="truncate-end">
					<Text
						color={i === menuSel ? "cyan" : undefined}
						bold={i === menuSel}
						dimColor={i !== menuSel}
					>
						{i === menuSel ? "❯ " : "  "}
						{c.value}
					</Text>
					{c.description ? <Text dimColor> {c.description}</Text> : null}
				</Text>
			))}
		</Box>
	) : null;

	const showPlaceholder = value.length === 0 && !disabled;

	if (showPlaceholder) {
		return (
			<Text>
				<Text inverse> </Text>
				<Text dimColor>{placeholder}</Text>
			</Text>
		);
	}

	if (disabled) {
		// No cursor rendered when disabled.
		return <Text dimColor={value.length === 0}>{value.length === 0 ? placeholder : value}</Text>;
	}

	// --- Explicit line breaking (when `columns` is set) ---
	// Instead of relying on terminal wrapping (which creates physical rows
	// without \n, causing Ink's log-update to under-erase and leave ghost
	// lines), break the text into explicit lines so each physical row
	// corresponds to a logical line in Ink's output.
	if (columns != null && columns > 0) {
		const lines = breakLines(value, columns);
		const { cursorLine, cursorCol } = findCursorInLines(lines, pos);

		return (
			<Box flexDirection="column">
				{lines.map((line, lineIdx) => {
					if (lineIdx === cursorLine) {
						// This line contains the cursor.
						const cluster = graphemeAt(line, cursorCol);
						if (cluster === null) {
							// Cursor at end of this line (or end of string).
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are immutable per render
								<Text key={lineIdx}>
									{line}
									<Text inverse> </Text>
								</Text>
							);
						}
						const cStart = cursorCol;
						const cEnd = cStart + cluster.length;
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: lines are immutable per render
							<Text key={lineIdx}>
								{line.slice(0, cStart)}
								<Text inverse>{cluster}</Text>
								{line.slice(cEnd)}
							</Text>
						);
					}
					// Non-cursor line.
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are immutable per render
						<Text key={lineIdx}>{line}</Text>
					);
				})}
				{menuNode}
			</Box>
		);
	}

	// --- Single-line rendering (no columns prop) ---
	const cluster = graphemeAt(value, pos);

	if (cluster === null) {
		// Cursor is past end-of-string — render as a trailing inverse space.
		return (
			<Box flexDirection="column">
				<Text>
					{value}
					<Text inverse> </Text>
				</Text>
				{menuNode}
			</Box>
		);
	}

	const clusterStart = pos; // by invariant, pos sits on a boundary
	const clusterEnd = clusterStart + cluster.length;

	return (
		<Box flexDirection="column">
			<Text>
				{value.slice(0, clusterStart)}
				<Text inverse>{cluster}</Text>
				{value.slice(clusterEnd)}
			</Text>
			{menuNode}
		</Box>
	);
}
