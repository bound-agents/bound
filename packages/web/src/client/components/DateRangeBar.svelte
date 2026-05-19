<script lang="ts">
interface Props {
	from: string;
	to: string;
	onRangeChange: (from: string, to: string) => void;
	disabled?: boolean;
}

let { from, to, onRangeChange, disabled = false }: Props = $props();

let activePreset = $state<"24h" | "7d" | "30d" | "all" | "custom">("24h");
let customFrom = $state("");
let customTo = $state("");
let debounceTimer: ReturnType<typeof setTimeout> | null = $state(null);
let validationError = $state(false);

// Convert ISO timestamp to datetime-local format
function isoToDatetimeLocal(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");
	return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Convert datetime-local to ISO timestamp
function datetimeLocalToIso(datetimeLocal: string): string {
	if (!datetimeLocal) return "";
	// datetime-local is in local time, convert to UTC
	const date = new Date(datetimeLocal);
	return date.toISOString();
}

function applyPreset(preset: "24h" | "7d" | "30d" | "all"): void {
	const now = new Date();
	let newFrom: string;
	let newTo = now.toISOString();

	switch (preset) {
		case "24h":
			newFrom = new Date(Date.now() - 24 * 3600_000).toISOString();
			break;
		case "7d":
			newFrom = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
			break;
		case "30d":
			newFrom = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
			break;
		case "all":
			newFrom = "2020-01-01T00:00:00.000Z";
			break;
	}

	activePreset = preset;
	validationError = false;
	onRangeChange(newFrom, newTo);
}

function handleCustomInput(): void {
	activePreset = "custom";
	if (debounceTimer !== null) {
		clearTimeout(debounceTimer);
	}

	debounceTimer = setTimeout(() => {
		validateAndApplyCustomRange();
	}, 300);
}

function validateAndApplyCustomRange(): void {
	const fromIso = datetimeLocalToIso(customFrom);
	const toIso = datetimeLocalToIso(customTo);

	if (!fromIso || !toIso) {
		validationError = true;
		return;
	}

	const fromTime = new Date(fromIso).getTime();
	const toTime = new Date(toIso).getTime();

	// Validate: from < to
	if (fromTime >= toTime) {
		validationError = true;
		return;
	}

	// Clamp future end dates to now
	const now = new Date();
	let finalTo = toIso;
	if (toTime > now.getTime()) {
		finalTo = now.toISOString();
	}

	validationError = false;
	onRangeChange(fromIso, finalTo);
}

// Initialize custom inputs when component mounts or props change
$effect(() => {
	customFrom = isoToDatetimeLocal(from);
	customTo = isoToDatetimeLocal(to);
});
</script>

<div class="date-range-bar" class:disabled>
	<div class="presets">
		<button
			class="preset-pill"
			class:active={activePreset === "24h"}
			onclick={() => applyPreset("24h")}
			{disabled}
		>
			24h
		</button>
		<button
			class="preset-pill"
			class:active={activePreset === "7d"}
			onclick={() => applyPreset("7d")}
			{disabled}
		>
			7d
		</button>
		<button
			class="preset-pill"
			class:active={activePreset === "30d"}
			onclick={() => applyPreset("30d")}
			{disabled}
		>
			30d
		</button>
		<button
			class="preset-pill"
			class:active={activePreset === "all"}
			onclick={() => applyPreset("all")}
			{disabled}
		>
			All
		</button>
	</div>

	<div class="custom-inputs" class:error={validationError}>
		<input
			type="datetime-local"
			bind:value={customFrom}
			onchange={handleCustomInput}
			oninput={handleCustomInput}
			{disabled}
			class="date-input"
		/>
		<span class="separator">to</span>
		<input
			type="datetime-local"
			bind:value={customTo}
			onchange={handleCustomInput}
			oninput={handleCustomInput}
			{disabled}
			class="date-input"
		/>
	</div>

	{#if validationError}
		<div class="error-hint">Invalid range: from must be before to</div>
	{/if}
</div>

<style>
	.date-range-bar {
		display: flex;
		gap: 16px;
		align-items: center;
		flex-wrap: wrap;
		padding: 12px 0;
	}

	.date-range-bar.disabled {
		opacity: 0.5;
		pointer-events: none;
	}

	.presets {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: center;
	}

	.preset-pill {
		padding: 5px 12px;
		background: transparent;
		border: 1px solid var(--rule-soft);
		color: var(--ink-2);
		cursor: pointer;
		font-family: var(--font-display);
		font-size: 12px;
		font-weight: 500;
		border-radius: 4px;
		transition: all 0.15s ease;
	}

	.preset-pill:hover:not(:disabled) {
		border-color: var(--ink-3);
	}

	.preset-pill.active {
		background: var(--ink);
		color: var(--paper);
		border-color: var(--ink);
	}

	.preset-pill:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.custom-inputs {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}

	.custom-inputs.error .date-input {
		border-color: var(--err);
	}

	.date-input {
		padding: 6px 8px;
		border: 1px solid var(--rule-soft);
		background: transparent;
		color: var(--ink);
		font-family: var(--font-mono);
		font-size: 12px;
		border-radius: 4px;
		transition: border-color 0.15s ease;
	}

	.date-input:focus {
		outline: none;
		border-color: var(--ink);
	}

	.date-input:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.separator {
		color: var(--ink-3);
		font-size: 12px;
		font-family: var(--font-display);
		font-weight: 500;
	}

	.error-hint {
		flex-basis: 100%;
		font-size: 11px;
		color: var(--err);
		font-style: italic;
	}
</style>
