import { Box, Text } from "ink";
import type React from "react";
import type { GraphicsCursorMode } from "../util/terminal-graphics";

export interface GraphicsImageProps {
	/** The full graphics-protocol escape (kitty or iTerm2), emitted verbatim. */
	escape: string;
	/** Terminal rows the image occupies. Only load-bearing under `reserve`,
	 *  where the explicit-height Box supplies the reservation + per-row border. */
	rows: number;
	/** Who owns the vertical footprint — see GraphicsCursorMode. `reserve`
	 *  (default): Ink reserves `rows` and paints the border down the left.
	 *  `advance`: the terminal's own cursor advance is the reservation, so this
	 *  emits a single line and Ink adds no phantom rows to double/overpaint. */
	mode?: GraphicsCursorMode;
}

/**
 * Render a real terminal image into a height-reserved box.
 *
 * The escape sits on the first row; the explicit `height={rows}` makes Ink
 * lay out a `rows`-tall region and pad the remaining rows blank. kitty draws
 * with C=1 (no cursor move) into that region; iTerm2 advances the cursor by
 * its own `height` cells — either way the reservation is `rows`, so nothing
 * below the image gets overpainted.
 *
 * ONLY valid inside <Static>. The dynamic region (in-flight card, staged
 * chip) must never mount this — a graphics escape there ghosts on the next
 * log-update erase. Callers gate on the committed-render path.
 */
export function GraphicsImage({
	escape: escapeSeq,
	rows,
	mode = "reserve",
}: GraphicsImageProps): React.ReactElement {
	// advance: one Ink line; the terminal advances the cursor by the image's own
	// height, so no phantom rows exist for the escape's paint to fight.
	if (mode === "advance") {
		return <Text>{escapeSeq}</Text>;
	}
	// reserve: reserve exactly `rows` so layout accounting matches the pixels and
	// the card border draws down the image's left edge.
	return (
		<Box flexDirection="column" height={rows}>
			<Text>{escapeSeq}</Text>
		</Box>
	);
}
