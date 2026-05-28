import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface TextInputProps {
	onSubmit: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	/** Available columns for text. When set, the component renders explicit
	 *  line breaks at column boundaries instead of relying on terminal
	 *  wrapping. This ensures Ink's logical line count matches the physical
	 *  row count, preventing ghost lines when the input height changes. */
	columns?: number;
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

export function TextInput({
	onSubmit,
	placeholder = "",
	disabled = false,
	columns,
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

			// Up/Down: no multi-line support yet; swallow so they don't leak
			// as stray characters.
			if (key.upArrow || key.downArrow) {
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

			// --- Editing keys ---

			if (key.return) {
				onSubmit(value);
				setState({ value: "", pos: 0 });
				return;
			}

			if (key.backspace) {
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
				return;
			}

			if (key.delete) {
				// Delete the grapheme cluster AT the cursor (forward delete).
				// Backspace removes left of cursor; Delete removes right.
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
				return;
			}

			// Swallow any remaining control sequences.
			if (key.ctrl || key.meta || key.escape) {
				return;
			}

			// --- Character input ---
			if (input && input.length > 0) {
				// Filter out mouse escape sequences that leak through Ink's parser.
				if (input.startsWith("[<") || input.startsWith("[M")) {
					return;
				}
				setState((s) => ({
					value: s.value.slice(0, s.pos) + input + s.value.slice(s.pos),
					pos: s.pos + input.length,
				}));
			}
		},
		{ isActive: !disabled },
	);

	// Render the value with the cursor drawn ON TOP OF the grapheme cluster
	// at `pos` (via inverse video), rather than INSERTED between characters.
	// This keeps column positions stable as the cursor moves, and renders
	// multi-codepoint graphemes (emoji, flags, combining marks) as a single
	// unit under the cursor instead of half-glyphs.
	//
	// At end-of-string (pos === value.length), the cursor is rendered as a
	// trailing inverse-video space so it remains visible.

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
			</Box>
		);
	}

	// --- Single-line rendering (no columns prop) ---
	const cluster = graphemeAt(value, pos);

	if (cluster === null) {
		// Cursor is past end-of-string — render as a trailing inverse space.
		return (
			<Text>
				{value}
				<Text inverse> </Text>
			</Text>
		);
	}

	const clusterStart = pos; // by invariant, pos sits on a boundary
	const clusterEnd = clusterStart + cluster.length;

	return (
		<Text>
			{value.slice(0, clusterStart)}
			<Text inverse>{cluster}</Text>
			{value.slice(clusterEnd)}
		</Text>
	);
}
