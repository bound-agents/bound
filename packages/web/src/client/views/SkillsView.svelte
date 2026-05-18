<script lang="ts">
import Page from "../components/Page.svelte";
import SectionHeader from "../components/SectionHeader.svelte";
</script>

<Page>
	{#snippet children()}
		<SectionHeader number={6} title="Skills" />
		<div class="state">Loading...</div>
	{/snippet}
</Page>

<style>
	.state {
		padding: 40px 16px;
		text-align: center;
		color: var(--text-dim);
	}
</style>
