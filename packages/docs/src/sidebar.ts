export type SidebarItem =
	| { label: string; slug: string }
	| { label: string; autogenerate: { directory: string } };

export interface SidebarGroup {
	label: string;
	items: SidebarItem[];
}

export const sidebar: SidebarGroup[] = [
	{
		label: "Start here",
		items: [{ label: "Introduction", slug: "index" }],
	},
	{
		label: "Tutorials",
		items: [{ label: "Quick start", slug: "guides/quick-start" }],
	},
	{
		label: "How-to guides",
		items: [
			{ label: "Use the boundless client", slug: "guides/boundless" },
			{ label: "Connect an ACP editor", slug: "guides/acp-editor" },
			{ label: "Configure a multi-host cluster", slug: "guides/multi-host" },
			{ label: "Connect MCP servers", slug: "guides/mcp-servers" },
			{ label: "Create a webhook", slug: "guides/webhooks" },
			{ label: "Add an RSS feed", slug: "guides/rss-feeds" },
			{ label: "Manage skills", slug: "guides/manage-skills" },
			{ label: "Orchestrate work with Yard", slug: "guides/orchestrate-with-yard" },
		],
	},
	{
		label: "Explanation",
		items: [
			{ label: "How Bound fits together", slug: "concepts/system-model" },
			{ label: "Agent loop and tools", slug: "concepts/agent-system" },
			{ label: "Work lifecycle and reliability", slug: "concepts/work-lifecycle" },
			{ label: "State, consistency, and multi-host operation", slug: "concepts/sync" },
			{ label: "Security and execution boundaries", slug: "concepts/security-boundaries" },
			{ label: "Sandbox and filesystems", slug: "concepts/sandbox" },
			{ label: "Inference and model routing", slug: "concepts/inference" },
			{ label: "Memory and knowledge graph", slug: "concepts/memory" },
			{ label: "Skills and activation", slug: "concepts/skills" },
			{ label: "Auxiliary agents", slug: "concepts/auxiliary-agents" },
		],
	},
	{
		label: "Reference",
		items: [
			{ label: "Web UI", slug: "concepts/web-ui" },
			{ label: "CLI and operations", slug: "guides/cli-operations" },
			{ label: "Agent tools", slug: "reference/agent-tools" },
			{ label: "Yard reference", slug: "reference/yard" },
			{ label: "Configuration", slug: "reference/configuration" },
			{ label: "Architecture", slug: "reference/architecture" },
			{ label: "Responses API", slug: "reference/responses-api" },
		],
	},
];
