<script lang="ts">
const {
	role,
	content,
	toolName = null,
	modelId = null,
} = $props<{
	role: "user" | "assistant" | "tool_call" | "tool_result" | "alert" | "system";
	content: string;
	toolName?: string | null;
	modelId?: string | null;
}>();

let toolCallExpanded = $state(false);

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
			<span class="tool-icon">⚙</span>
			<span class="tool-name">{getToolName()}</span>
			<span class="tool-toggle">{toolCallExpanded ? "▲" : "▼"}</span>
		</div>
		{#if toolCallExpanded}
			<pre class="tool-content">{content}</pre>
		{/if}
	</div>
{:else if role === "tool_result"}
	<div class="message-bubble tool_result">
		<div class="role-badge">result</div>
		<pre class="tool-output">{content}</pre>
	</div>
{:else if role === "alert"}
	<div class="message-bubble alert">
		<div class="role-badge alert-badge">⚠ alert</div>
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
				{modelId}
			{:else}
				{role}
			{/if}
		</div>
		<div class="content">{content}</div>
	</div>
{/if}

<style>
	.message-bubble {
		padding: 12px 16px;
		margin: 8px 0;
		border-radius: 8px;
		background: #16213e;
		border-left: 3px solid #0f3460;
	}

	.user {
		background: #1e5a5a;
		border-left-color: #00a884;
	}

	.assistant {
		background: #3d2a2a;
		border-left-color: #ff6b6b;
	}

	.tool_call {
		background: #1a1a30;
		border-left-color: #8f76d6;
	}

	.tool_result {
		background: #0d1a0d;
		border-left-color: #009944;
	}

	.alert {
		background: #2a1010;
		border-left-color: #ff1744;
	}

	.system {
		background: transparent;
		border-left: none;
		text-align: center;
		padding: 4px 16px;
	}

	.role-badge {
		font-size: 12px;
		color: #888;
		margin-bottom: 4px;
	}

	.alert-badge {
		color: #ff9100;
		font-weight: 600;
	}

	.content {
		word-wrap: break-word;
	}

	.system-text {
		font-style: italic;
		color: #6b6b80;
		font-size: 13px;
	}

	.tool-call-header {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		user-select: none;
	}

	.tool-icon {
		color: #8f76d6;
		font-size: 14px;
	}

	.tool-name {
		font-weight: 600;
		color: #c4b5f4;
		font-size: 13px;
		flex: 1;
	}

	.tool-toggle {
		color: #6b6b80;
		font-size: 11px;
	}

	.tool-content {
		margin-top: 8px;
		padding: 8px;
		background: #0d0d1a;
		border-radius: 4px;
		font-family: "JetBrains Mono", "Fira Code", monospace;
		font-size: 12px;
		color: #c4b5f4;
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
	}

	.tool-output {
		margin: 4px 0 0;
		padding: 8px;
		background: #0a150a;
		border-radius: 4px;
		font-family: "JetBrains Mono", "Fira Code", monospace;
		font-size: 12px;
		color: #69f0ae;
		white-space: pre-wrap;
		word-break: break-all;
		overflow-x: auto;
	}
</style>
