<script lang="ts">
	import { onMount } from "svelte";

	interface Props {
		secret: string;
		webhookName: string;
		onClose: () => void;
	}

	const { secret, webhookName, onClose }: Props = $props();

	let modalRef: HTMLDivElement | undefined;
	let copyButton: HTMLButtonElement | undefined = $state();
	let copied = $state(false);
	let copyFailed = $state(false);
	let previouslyFocused: HTMLElement | null = null;

	onMount(() => {
		previouslyFocused = document.activeElement as HTMLElement;
		(copyButton ?? modalRef)?.focus();
	});

	async function copyToClipboard(): Promise<void> {
		copyFailed = false;
		try {
			if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
			await navigator.clipboard.writeText(secret);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch {
			copied = false;
			copyFailed = true;
		}
	}

	function close(): void {
		previouslyFocused?.focus();
		onClose();
	}

	function focusables(): HTMLElement[] {
		if (!modalRef) return [];
		return Array.from(
			modalRef.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			),
		);
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			return;
		}
		if (e.key === "Tab") {
			const items = focusables();
			if (items.length === 0) {
				e.preventDefault();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !modalRef?.contains(active))) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !modalRef?.contains(active))) {
				e.preventDefault();
				first.focus();
			}
		}
	}
</script>

<!-- Backdrop clicks are ignored: the one-time secret must not vanish on a stray click. -->
<div class="modal-backdrop" onkeydown={handleKeydown} role="presentation">
	<div
		class="modal-panel"
		role="dialog"
		aria-modal="true"
		aria-label="Webhook secret"
		bind:this={modalRef}
		tabindex={-1}
	>
		<header class="modal-header">
			<h2 class="modal-title">Secret for '{webhookName}'</h2>
			<button class="close-btn" aria-label="Close" onclick={close}>×</button>
		</header>
		<div class="modal-body">
			<p class="warning">Save this secret now — it will not be shown again.</p>
			<div class="secret-display">
				<code class="secret-value">{secret}</code>
				<button class="copy-btn" bind:this={copyButton} onclick={copyToClipboard}>
					{copied ? "Copied!" : "Copy"}
				</button>
			</div>
			{#if copyFailed}
				<p class="copy-error" role="alert">Copy failed — select and copy manually.</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.copy-error {
		margin: 8px 0 0;
		color: var(--err, #b3261e);
		font-size: 12px;
	}
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

	.backdrop-close {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		background: none;
		border: none;
		cursor: default;
		padding: 0;
	}

	.modal-panel {
		position: relative;
		z-index: 1;
		background: var(--paper);
		border: 1px solid var(--ink);
		border-radius: 0;
		width: min(600px, 100%);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 30px 60px rgba(0, 0, 0, 0.25);
		padding: 0;
	}

	.modal-panel:focus {
		outline: none;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 18px;
		border-bottom: 1px solid var(--ink);
		background: var(--paper-3);
		flex-shrink: 0;
	}

	.modal-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		background: transparent;
		border: 1px solid var(--rule-soft);
		color: var(--ink-2);
		cursor: pointer;
		transition: all 0.15s ease;
		border-radius: 0;
		font-size: 20px;
		line-height: 1;
		flex-shrink: 0;
	}

	.close-btn:hover {
		background: var(--paper-2);
		color: var(--accent);
		border-color: var(--accent);
	}

	.close-btn:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.modal-body {
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.warning {
		margin: 0;
		color: var(--err);
		font-size: 13px;
		font-weight: 600;
	}

	.secret-display {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.secret-value {
		flex: 1;
		padding: 8px 12px;
		background: var(--paper-2);
		border: 1px solid var(--rule-soft);
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--ink-2);
		word-break: break-all;
		display: block;
		border-radius: 0;
	}

	.copy-btn {
		padding: 6px 16px;
		background: transparent;
		border: 1px solid var(--ink);
		color: var(--ink);
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		border-radius: 0;
		white-space: nowrap;
		transition: all 0.15s ease;
	}

	.copy-btn:hover {
		background: var(--paper-2);
	}

	.copy-btn:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
