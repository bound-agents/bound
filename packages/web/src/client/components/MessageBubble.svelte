<script lang="ts">
const {
	// biome-ignore lint/correctness/noUnusedVariables: used in template
	role,
	content,
	toolName = null,
	// biome-ignore lint/correctness/noUnusedVariables: used in template
	modelId = null,
} = $props<{
	role: "user" | "assistant" | "tool_call" | "tool_result" | "alert" | "system";
	content: string;
	toolName?: string | null;
	modelId?: string | null;
}>();

let toolCallExpanded = $state(false);

// biome-ignore lint/correctness/noUnusedVariables: used in template
function getToolName(): string {
	if (toolName) return toolName;
	// Attempt to parse from JSON content if tool_name field not provided separately
	try {
		const parsed = JSON.parse(content) as { name?: string; tool?: string };
		return parsed.name ?? parsed.tool ?? "tool";
	} catch {
		return "tool";
	}
}

// biome-ignore lint/correctness/noUnusedVariables: used in template
function toggleToolCall(): void {
	toolCallExpanded = !toolCallExpanded;
}
</script>

{#if role === "tool_call"}
	<div class="message-bubble tool_call">
		<div class="tool-call-header" onclick={toggleToolCall} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") toggleToolCall(); }} role="button" tabindex={0}>
			<span class="tool-icon">&#9881;</span>
			<span class="tool-name">{getToolName()}</span>
			<span class="tool-toggle">{toolCallExpanded ? "&#9650;" : "&#9660;"}</span>
		</div>
		{#if toolCallExpanded}
			<pre class="tool-content">{content}</pre>
		{/if}
	</div>
{:else if role === "tool_result"}
	<div class="message-bubble tool_result">
		<div class="role-badge result-badge">result</div>
		<pre class="tool-output">{content}</pre>
	</div>
{:else if role === "alert"}
	<div class="message-bubble alert">
		<div class="role-badge alert-badge">! alert</div>
		<div class="content">{content}</div>
	</div>
{:else if role === "system"}
	<div class="message-bubble system">
		<div class="content system-text">{content}</div>
	</div>
{:else}
	<div class="message-bubble {role}">
		<div class="role-badge">
			{#if role === "assistant" && modelId}
				<span class="model-pill">{modelId}</span>
			{:else}
				{role}
			{/if}
		</div>
		<div class="content">{content}</div>
	</div>
{/if}

<style>
	.message-bubble {
		padding: 14px 18px;
		margin: 10px 0;
		border-radius: 8px;
		background: var(--bg-secondary);
		border-left: 3px solid var(--bg-surface);
		transition: background 0.15s ease;
		line-height: 1.55;
	}

	/* User messages: teal/green tint, Namboku emerald accent */
	.user {
		background: rgba(0, 172, 155, 0.1);
		border-left-color: var(--line-7);
	}

	/* Assistant messages: warm tone, Ginza orange accent */
	.assistant {
		background: rgba(243, 151, 0, 0.08);
		border-left-color: var(--line-0);
	}

	/* Tool calls: technical blue/purple, Hanzomon purple accent */
	.tool_call {
		background: rgba(143, 118, 214, 0.08);
		border-left-color: var(--line-6);
		border-left-style: dashed;
	}

	/* Tool results: Chiyoda green accent */
	.tool_result {
		background: rgba(0, 153, 68, 0.06);
		border-left-color: var(--line-4);
	}

	/* Alerts: disruption red */
	.alert {
		background: rgba(255, 23, 68, 0.08);
		border-left-color: var(--alert-disruption);
		box-shadow: 0 0 12px rgba(255, 23, 68, 0.08);
	}

	/* System: subtle, centered */
	.system {
		background: transparent;
		border-left: none;
		text-align: center;
		padding: 6px 18px;
	}

	.role-badge {
		font-family: var(--font-display);
		font-size: var(--text-xs);
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 6px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.model-pill {
		display: inline-block;
		padding: 2px 8px;
		background: rgba(243, 151, 0, 0.12);
		border: 1px solid rgba(243, 151, 0, 0.25);
		border-radius: 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--line-0);
		text-transform: none;
		letter-spacing: 0;
	}

	.result-badge {
		color: var(--line-4);
	}

	.alert-badge {
		color: var(--alert-warning);
		font-weight: 700;
	}

	.content {
		word-wrap: break-word;
		font-size: var(--text-base);
		color: var(--text-primary);
	}

	.system-text {
		font-style: italic;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.tool-call-header {
		display: flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
		user-select: none;
		padding: 2px 0;
	}

	.tool-call-header:focus-visible {
		outline: 2px solid var(--line-6);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.tool-icon {
		color: var(--line-6);
		font-size: 15px;
	}

	.tool-name {
		font-family: var(--font-mono);
		font-weight: 600;
		color: #c4b5f4;
		font-size: var(--text-sm);
		flex: 1;
	}

	.tool-toggle {
		color: var(--text-muted);
		font-size: 10px;
		transition: transform 0.2s ease;
	}

	.tool-content {
		margin-top: 10px;
		padding: 12px;
		background: rgba(10, 10, 20, 0.6);
		border: 1px solid rgba(143, 118, 214, 0.15);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: #c4b5f4;
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}

	.tool-output {
		margin: 6px 0 0;
		padding: 12px;
		background: rgba(0, 153, 68, 0.05);
		border: 1px solid rgba(0, 153, 68, 0.12);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--status-active);
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
		line-height: 1.5;
	}
</style>
