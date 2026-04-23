import { Text, useInput } from "ink";
import type React from "react";
import { useRef, useState } from "react";

export interface TextInputProps {
	onSubmit: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
	/** When set, clips the rendered text to this many columns and scrolls
	 *  horizontally to keep the cursor visible. Prevents line wrapping. */
	viewportWidth?: number;
}

/**
 * Compute the visible slice of text for a single-line viewport.
 *
 * Returns the string-index range [start, end) to render plus the new scroll
 * offset to feed back on the next call. The offset only changes when the
 * cursor exits the current viewport, so the view stays rock-steady during
 * normal typing.
 *
 * @param textLength  Total string length (value.length)
 * @param cursorPos   Current cursor position (string index, 0..textLength)
 * @param viewportWidth  Available columns
 * @param prevOffset  Previous scroll offset (pass 0 on first call)
 */
export function computeViewport(
	textLength: number,
	cursorPos: number,
	viewportWidth: number,
	prevOffset: number,
): { start: number; end: number; offset: number } {
	// Reserve 1 column for the cursor block (trailing inverse space at EOL,
	// or the highlighted grapheme cluster mid-text — either way, 1 col).
	const maxVisible = viewportWidth - 1;

	// Everything fits — no scrolling needed.
	if (textLength <= maxVisible) {
		return { start: 0, end: textLength, offset: 0 };
	}

	let offset = prevOffset;

	// Cursor moved past the right edge — scroll right.
	if (cursorPos > offset + maxVisible) {
		offset = cursorPos - maxVisible;
	}

	// Cursor moved before the left edge — scroll left.
	if (cursorPos < offset) {
		offset = cursorPos;
	}

	// Clamp.
	offset = Math.max(0, offset);
	offset = Math.min(offset, Math.max(0, textLength - maxVisible));

	const start = offset;
	const end = Math.min(start + maxVisible, textLength);

	return { start, end, offset };
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
	viewportWidth,
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

	// Viewport scroll offset — persisted across renders via ref so the
	// viewport stays stable when only the cursor moves within bounds.
	const vpOffsetRef = useRef(0);

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

	// --- Viewport clipping (when viewportWidth is set) ---
	// Compute the visible slice of the value string, keeping the cursor
	// in view. Without viewportWidth the full string renders (legacy).
	let visValue = value;
	let visPos = pos;

	if (viewportWidth != null && viewportWidth > 0) {
		const vp = computeViewport(value.length, pos, viewportWidth, vpOffsetRef.current);
		vpOffsetRef.current = vp.offset;
		visValue = value.slice(vp.start, vp.end);
		visPos = pos - vp.start;
	}

	const showPlaceholder = visValue.length === 0 && value.length === 0 && !disabled;

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

	const cluster = graphemeAt(visValue, visPos);

	if (cluster === null) {
		// Cursor is past end-of-string — render as a trailing inverse space.
		return (
			<Text>
				{visValue}
				<Text inverse> </Text>
			</Text>
		);
	}

	const clusterStart = visPos; // by invariant, pos sits on a boundary
	const clusterEnd = clusterStart + cluster.length;

	return (
		<Text>
			{visValue.slice(0, clusterStart)}
			<Text inverse>{cluster}</Text>
			{visValue.slice(clusterEnd)}
		</Text>
	);
}
