import { Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface TextInputProps {
	onSubmit: (value: string) => void;
	placeholder?: string;
	disabled?: boolean;
}

/**
 * Word boundary helpers for Option/Alt+Arrow navigation.
 * A "word" is a maximal run of non-whitespace characters.
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
					setState((s) => ({ ...s, pos: Math.max(0, s.pos - 1) }));
				}
				return;
			}

			if (key.rightArrow) {
				if (key.meta || key.ctrl) {
					setState((s) => ({ ...s, pos: wordRight(s.value, s.pos) }));
				} else {
					setState((s) => ({
						...s,
						pos: Math.min(s.value.length, s.pos + 1),
					}));
				}
				return;
			}

			// Up/Down: no multi-line support yet; swallow so they don't leak
			// as stray characters.
			if (key.upArrow || key.downArrow) {
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
				// Delete the character before the cursor.
				setState((s) => {
					if (s.pos <= 0) {
						return s;
					}
					return {
						value: s.value.slice(0, s.pos - 1) + s.value.slice(s.pos),
						pos: s.pos - 1,
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

	// Render the value with the cursor drawn ON TOP OF the character at
	// `pos` (via inverse video), rather than INSERTED between characters.
	// This keeps column positions stable as the cursor moves — characters
	// to the right of the cursor do not shift when `pos` changes.
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

	const before = value.slice(0, pos);
	const atCursor = value[pos];
	const after = value.slice(pos + 1);

	if (atCursor === undefined) {
		// Cursor is past end-of-string — render as a trailing inverse space.
		return (
			<Text>
				{before}
				<Text inverse> </Text>
			</Text>
		);
	}

	return (
		<Text>
			{before}
			<Text inverse>{atCursor}</Text>
			{after}
		</Text>
	);
}
