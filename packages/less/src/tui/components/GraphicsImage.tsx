import { Box, Text } from "ink";
import type React from "react";

export interface GraphicsImageProps {
	/** The full graphics-protocol escape (kitty or iTerm2), emitted verbatim. */
	escape: string;
	/** Terminal rows the image occupies. The Box reserves exactly this many so
	 *  the layout engine's height accounting matches the pixels the terminal
	 *  paints — the <Static>-only ghost-card guarantee. */
	rows: number;
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
export function GraphicsImage({ escape: escapeSeq, rows }: GraphicsImageProps): React.ReactElement {
	return (
		<Box flexDirection="column" height={rows}>
			<Text>{escapeSeq}</Text>
		</Box>
	);
}
