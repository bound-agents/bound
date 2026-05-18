<script lang="ts">
import Btn from "./Btn.svelte";

interface Props {
	onClose: () => void;
	onCreated: () => void;
}
let { onClose, onCreated }: Props = $props();

let mode = $state<"form" | "upload">("form");
let submitting = $state(false);
let serverError = $state<string | null>(null);

function handleKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") {
		onClose();
	}
}
</script>

<div class="modal-backdrop" onclick={onClose} onkeydown={handleKeydown} role="presentation">
	<div class="modal-panel" role="dialog" aria-modal="true" aria-label="Create Skill" onclick={(e) => e.stopPropagation()}>
		<header class="modal-header">
			<h2>Create Skill</h2>
			<div class="mode-tabs">
				<button class:active={mode === "form"} onclick={() => { mode = "form"; }}>Form</button>
				<button class:active={mode === "upload"} onclick={() => { mode = "upload"; }}>Upload</button>
			</div>
		</header>

		<div class="modal-body">
			<!-- Placeholder content for modes -->
			{#if mode === "form"}
				<p>Form mode coming next</p>
			{:else}
				<p>Upload mode coming next</p>
			{/if}
		</div>

		<div class="modal-footer">
			<Btn variant="default" onclick={onClose}>
				{#snippet children()}Cancel{/snippet}
			</Btn>
			<Btn variant="primary" disabled={submitting} onclick={() => {}}>
				{#snippet children()}{submitting ? "Creating..." : "Create"}{/snippet}
			</Btn>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(26, 24, 20, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 32px;
	}

	.modal-panel {
		position: relative;
		z-index: 1;
		background: var(--paper);
		border: 1px solid var(--rule-soft);
		border-radius: 0;
		max-width: 640px;
		width: 90%;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 30px 60px rgba(0, 0, 0, 0.25);
	}

	.modal-header {
		padding: 16px 20px;
		border-bottom: 1px solid var(--rule-soft);
		flex-shrink: 0;
	}

	.modal-header h2 {
		margin: 0 0 12px 0;
		font-family: var(--font-header);
		font-size: 18px;
		font-weight: 600;
		color: var(--ink);
	}

	.mode-tabs {
		display: flex;
		gap: 8px;
	}

	.mode-tabs button {
		padding: 6px 12px;
		background: transparent;
		border: 1px solid var(--rule-soft);
		color: var(--ink-2);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 0;
		transition: background 0.2s, border-color 0.2s;
	}

	.mode-tabs button:hover {
		background: var(--paper-2);
	}

	.mode-tabs button.active {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
	}

	.modal-body {
		padding: 20px;
		overflow-y: auto;
		max-height: 60vh;
		flex: 1;
		min-height: 0;
	}

	.modal-footer {
		padding: 12px 20px;
		border-top: 1px solid var(--rule-soft);
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		flex-shrink: 0;
	}
</style>
