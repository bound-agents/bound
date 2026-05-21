/**
 * Svelte action that calls `onResize` with the element's current pixel
 * width whenever it changes (and once synchronously on attach).
 *
 * Used by chart components to render their SVG viewBox at 1:1 with screen
 * pixels rather than `width="100%"` on a fixed viewBox — the latter
 * stretches the entire SVG including text labels, blowing up font sizes on
 * wide screens and clipping labels on narrow ones.
 *
 * Usage:
 *   <div use:observeWidth={(w) => containerWidth = w}>...</div>
 */
export function observeWidth(
	node: HTMLElement,
	onResize: (width: number) => void,
): { destroy: () => void } {
	const measure = (): void => {
		const rect = node.getBoundingClientRect();
		onResize(Math.max(0, Math.round(rect.width)));
	};

	if (typeof ResizeObserver === "undefined") {
		measure();
		return { destroy: (): void => {} };
	}

	const observer = new ResizeObserver(() => measure());
	observer.observe(node);
	measure();

	return {
		destroy: (): void => observer.disconnect(),
	};
}
