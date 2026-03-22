<script lang="ts">
import { onMount } from "svelte";
import { api } from "../lib/api";
import type { Thread } from "../lib/api";
// biome-ignore lint/correctness/noUnusedImports: used in template handlers
import { navigateTo } from "../lib/router";

// biome-ignore lint/correctness/noUnusedVariables: used in template
let threads: Thread[] = $state([]);
let creating = $state(false);

async function createThread(): Promise<void> {
	creating = true;
	try {
		const thread = await api.createThread();
		window.location.hash = `#/line/${thread.id}`;
	} catch (error) {
		console.error("Failed to create thread:", error);
		creating = false;
	}
}

onMount(async () => {
	try {
		threads = await api.listThreads();
	} catch (error) {
		console.error("Failed to load threads:", error);
	}
});

// Metro line colors (10-color palette)
// biome-ignore lint/correctness/noUnusedVariables: used in template
const colors = [
	"#FF0000", // Red
	"#0066CC", // Blue
	"#00AA00", // Green
	"#FFAA00", // Orange
	"#9900CC", // Purple
	"#00CCCC", // Cyan
	"#FF66CC", // Magenta
	"#FFFF00", // Yellow
	"#FF6600", // Dark Orange
	"#0099FF", // Light Blue
];
</script>

<div class="system-map">
	<h1>System Map</h1>

	<button class="new-thread-btn" onclick={createThread} disabled={creating}>
		{creating ? "Creating..." : "New Thread"}
	</button>

	{#if threads.length === 0}
		<p>No threads yet. Start a conversation to create one.</p>
	{:else}
		<svg viewBox="0 0 1200 600" class="metro-diagram">
			{#each threads as thread, idx}
				{@const color = colors[thread.color % colors.length]}
				{@const yPos = 100 + idx * 50}

				<!-- Line -->
				<line
					x1="50"
					y1={yPos}
					x2="1150"
					y2={yPos}
					stroke={color}
					stroke-width="8"
					class="metro-line"
				/>

				<!-- Thread label -->
				<text x="30" y={yPos + 15} font-size="12" fill="#e0e0e0" text-anchor="end">
					{thread.id.substring(0, 8)}
				</text>

				<!-- Station dots for recent messages -->
				<circle cx="100" cy={yPos} r="8" fill={color} class="station" />
				<circle cx="300" cy={yPos} r="8" fill={color} class="station" />
				<circle cx="500" cy={yPos} r="8" fill={color} class="station" />
				<circle cx="700" cy={yPos} r="8" fill={color} class="station" />
				<circle cx="900" cy={yPos} r="8" fill={color} class="station" />

				<!-- Clickable area -->
				<rect
					x="50"
					y={yPos - 25}
					width="1100"
					height="50"
					fill="transparent"
					class="line-clickable"
					onclick={() => navigateTo(`/line/${thread.id}`)}
					onkeydown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							navigateTo(`/line/${thread.id}`);
						}
					}}
					role="button"
					tabindex={idx}
				/>
			{/each}
		</svg>
	{/if}
</div>

<style>
	.system-map {
		padding: 40px;
	}

	h1 {
		margin-bottom: 30px;
		color: #e0e0e0;
	}

	p {
		color: #888;
	}

	.new-thread-btn {
		margin-bottom: 20px;
		padding: 8px 16px;
		background: #0f3460;
		color: #e0e0e0;
		border: 1px solid #1a4a8a;
		border-radius: 4px;
		cursor: pointer;
		font-size: 14px;
	}

	.new-thread-btn:hover:not(:disabled) {
		background: #1a4a8a;
	}

	.new-thread-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.metro-diagram {
		width: 100%;
		max-width: 1200px;
		height: 600px;
		background: #0a0a14;
		border: 1px solid #0f3460;
		border-radius: 8px;
	}

	.metro-line {
		stroke-linecap: round;
	}

	.station {
		cursor: pointer;
		opacity: 0.8;
		transition: opacity 200ms;
	}

	.station:hover {
		opacity: 1;
	}

	.line-clickable {
		cursor: pointer;
	}

	.line-clickable:hover {
		fill: rgba(255, 255, 255, 0.05);
	}
</style>
