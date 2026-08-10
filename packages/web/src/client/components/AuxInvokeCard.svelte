<script lang="ts">
import { Bot } from "lucide-svelte";
import StatusChip from "./StatusChip.svelte";
import ThreadLinkCard from "./ThreadLinkCard.svelte";

// Inline card for an aux-agent invocation (`aux invoke`) in the chat stream.
// Shows the invoked identity's name and a coarse status, with a link to the
// aux child thread. Aux threads are excluded from the thread directory
// (they're internal errands, not conversations), so this card is the only
// navigable door into one — the link matters more here than on TaskCard,
// where the Timetable offers a second route.
//
// Everything is derived from the persisted tool_use/tool_result pair (see
// ../lib/aux-invoke-cards.ts), so the card needs no fetch or WS refresh:
// when a background errand resolves, the tool_result row updates and the
// extraction re-derives status + threadId reactively.

interface Props {
	agentName: string;
	threadId: string | null;
	status: "running" | "completed" | "failed";
	lineColor?: string;
}

const { agentName, threadId, status, lineColor = "var(--rule-soft)" }: Props = $props();
</script>

<ThreadLinkCard
	{lineColor}
	{threadId}
	pendingLabel={status === "running" ? "Underway…" : null}
>
	{#snippet icon()}
		<Bot size={13} />
	{/snippet}

	<div class="ac-body">
		<div class="ac-line">
			<span class="ac-name mono">aux: {agentName}</span>
			<StatusChip status={status as never} size="sm" />
		</div>
	</div>
</ThreadLinkCard>

<style>
	.ac-body {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
		flex: 1;
	}

	.ac-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.ac-name {
		color: var(--ink);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
