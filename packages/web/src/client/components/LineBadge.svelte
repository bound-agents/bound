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
const fontSize = $derived(size === "compact" ? 10 : size === "large" ? 18 : 13);
</script>

<span
	role="img"
	aria-label="Line {code}"
	style="
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: {diameter}px;
		height: {diameter}px;
		border-radius: 50%;
		background: {color};
		color: white;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: {fontSize}px;
		letter-spacing: 0.02em;
		flex-shrink: 0;
		box-shadow: inset 0 0 0 2px rgba(255,255,255,0.18);
	"
>
	{code}
</span>
