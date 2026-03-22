<script lang="ts">
export let role: "user" | "assistant" | "tool_call" | "tool_result" | "alert" | "system";
export let content: string;
</script>

<div class="message-bubble {role}">
	<div class="role-badge">{role}</div>
	<div class="content">{content}</div>
</div>

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

	.role-badge {
		font-size: 12px;
		color: #888;
		margin-bottom: 4px;
	}

	.content {
		word-wrap: break-word;
	}
</style>
