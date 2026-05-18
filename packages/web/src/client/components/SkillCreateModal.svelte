<script lang="ts">
interface Props {
	onClose: () => void;
	onCreated: () => void;
}
let { onClose, onCreated }: Props = $props();
</script>

<div class="modal-backdrop">
	<div class="modal-panel">
		<h2>Create Skill</h2>
		<button onclick={onClose}>Close</button>
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
		background: var(--paper);
		border: 1px solid var(--ink);
		border-radius: 0;
		padding: 20px;
		max-width: 640px;
		width: 90%;
	}
</style>
