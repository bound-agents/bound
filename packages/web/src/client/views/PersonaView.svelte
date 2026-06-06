<script lang="ts">
import { onMount } from "svelte";
import Btn from "../components/Btn.svelte";
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";

// The persona is a single synced cluster_config row, read live at assembly
// time. Saving here propagates to every host and takes effect on the next turn
// cluster-wide — no per-host persona.md edits, no reload step.
let persona = $state("");
let original = $state("");
let modifiedAt = $state<string | null>(null);
let maxBytes = $state(64 * 1024);

let loading = $state(true);
let saving = $state(false);
let error = $state<string | null>(null);
let saved = $state(false);

const byteLength = $derived(new TextEncoder().encode(persona).length);
const overCap = $derived(byteLength > maxBytes);
const dirty = $derived(persona !== original);

onMount(() => {
	load();
});

async function load(): Promise<void> {
	try {
		loading = true;
		error = null;
		const res = await fetch("/api/persona");
		if (!res.ok) throw new Error(`GET /api/persona failed: ${res.status}`);
		const data = (await res.json()) as {
			persona: string;
			modified_at: string | null;
			max_bytes: number;
		};
		persona = data.persona;
		original = data.persona;
		modifiedAt = data.modified_at;
		maxBytes = data.max_bytes;
	} catch (err: unknown) {
		error = err instanceof Error ? err.message : "Failed to load persona.";
	} finally {
		loading = false;
	}
}

async function save(): Promise<void> {
	if (overCap || persona.length === 0 || saving) return;
	try {
		saving = true;
		error = null;
		saved = false;
		const res = await fetch("/api/persona", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ persona }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			throw new Error(body.error ?? `POST /api/persona failed: ${res.status}`);
		}
		original = persona;
		modifiedAt = new Date().toISOString();
		saved = true;
	} catch (err: unknown) {
		error = err instanceof Error ? err.message : "Failed to save persona.";
	} finally {
		saving = false;
	}
}

function revert(): void {
	persona = original;
	saved = false;
}
</script>

<Page>
	<SectionHeader
		title="Persona"
		subtitle="Cluster-wide system voice"
		number={9}
	>
		{#snippet actions()}
			<Btn variant="ghost" disabled={!dirty || saving} onclick={revert}>Revert</Btn>
			<Btn variant="primary" disabled={!dirty || overCap || persona.length === 0 || saving} onclick={save}>
				{saving ? "Saving…" : "Save"}
			</Btn>
		{/snippet}
	</SectionHeader>

	<p class="blurb">
		The persona is a single synced row, read live when context is assembled. A save
		propagates to every host on the next sync and takes effect on the following turn —
		including turns relayed to another host for inference.
	</p>

	{#if loading}
		<div class="state">Loading…</div>
	{:else}
		<textarea
			class="editor mono"
			bind:value={persona}
			spellcheck="false"
			placeholder="No persona set. Write the system voice here."
		></textarea>

		<div class="footer">
			<span class="count tnum" class:over={overCap}>
				{byteLength.toLocaleString()} / {maxBytes.toLocaleString()} bytes
			</span>
			{#if modifiedAt}
				<span class="meta">last set {new Date(modifiedAt).toLocaleString()}</span>
			{/if}
			{#if saved && !dirty}
				<span class="ok">Saved — propagating to cluster</span>
			{/if}
		</div>

		{#if overCap}
			<div class="err">Over the {maxBytes.toLocaleString()}-byte cap. Trim before saving.</div>
		{/if}
		{#if error}
			<div class="err">{error}</div>
		{/if}
	{/if}
</Page>

<style>
	.blurb {
		max-width: 70ch;
		color: var(--ink-2);
		font-size: 13px;
		line-height: 1.5;
		margin: 0 0 20px;
	}
	.blurb code {
		font-family: var(--font-mono);
		font-size: 12px;
		background: var(--paper-3);
		padding: 1px 4px;
	}
	.editor {
		width: 100%;
		min-height: 420px;
		resize: vertical;
		padding: 14px 16px;
		background: var(--paper);
		color: var(--ink);
		border: 1px solid var(--ink);
		border-radius: 0;
		font-size: 13px;
		line-height: 1.55;
		outline: none;
	}
	.editor:focus-visible {
		border-color: var(--accent);
	}
	.footer {
		display: flex;
		align-items: baseline;
		gap: 18px;
		margin-top: 10px;
		font-size: 12px;
		color: var(--ink-3);
	}
	.count.over {
		color: var(--err);
		font-weight: 600;
	}
	.meta {
		color: var(--ink-4);
	}
	.ok {
		color: var(--ok);
		font-weight: 600;
	}
	.err {
		margin-top: 10px;
		padding: 8px 12px;
		border-left: 3px solid var(--err);
		background: var(--accent-wash);
		color: var(--err);
		font-size: 13px;
	}
	.state {
		color: var(--ink-3);
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 40px 0;
	}
</style>
