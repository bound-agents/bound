<script lang="ts">
import { getLineCode, getLineColor } from "../lib/metro-lines";

interface Props {
	lineIndex: number;
	size?: "standard" | "compact";
}

let { lineIndex, size = "standard" }: Props = $props();

const code = $derived(getLineCode(lineIndex));
const color = $derived(getLineColor(lineIndex));
const diameter = $derived(size === "compact" ? 20 : 32);
const fontSize = $derived(size === "compact" ? 10 : 14);
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
		background-color: {color};
		color: white;
		font-family: var(--font-display);
		font-weight: 700;
		font-size: {fontSize}px;
		flex-shrink: 0;
	"
>
	{code}
</span>
