<script lang="ts">
import { getLineCode, getLineColor } from "../lib/metro-lines";

interface Props {
	lineIndex: number;
	size?: "compact" | "standard" | "large";
	label?: string | null;
}

let { lineIndex, size = "standard", label = null }: Props = $props();

const code = $derived(label ?? getLineCode(lineIndex));
const color = $derived(getLineColor(lineIndex));
const diameter = $derived(size === "compact" ? 18 : size === "large" ? 40 : 26);
const fontSize = $derived(size === "compact" ? 9 : size === "large" ? 17 : 12);
// Tokyo Metro marks are a thick colored annulus around a white field. The ring
// is ~22% of the diameter; scale the border with size so the proportion holds.
const ringWidth = $derived(size === "compact" ? 3 : size === "large" ? 7 : 4);
</script>

<span
	role="img"
	aria-label="Line {code}"
	style="
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		width: {diameter}px;
		height: {diameter}px;
		border-radius: 50%;
		background: #fff;
		border: {ringWidth}px solid {color};
		color: #1a1a1a;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: {fontSize}px;
		line-height: 1;
		letter-spacing: 0.01em;
		flex-shrink: 0;
	"
>
	{code}
</span>
