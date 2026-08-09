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
			{ label: "Configure a multi-host cluster", slug: "guides/multi-host" },
			{ label: "Connect MCP servers", slug: "guides/mcp-servers" },
			{ label: "Create a webhook", slug: "guides/webhooks" },
			{ label: "Add an RSS feed", slug: "guides/rss-feeds" },
		],
	},
	{
		label: "Concepts",
		items: [
			{ label: "Agent system", slug: "concepts/agent-system" },
			{ label: "Sync and multi-host", slug: "concepts/sync" },
			{ label: "Sandbox and filesystem", slug: "concepts/sandbox" },
			{ label: "Inference and model routing", slug: "concepts/inference" },
			{ label: "Memory and knowledge graph", slug: "concepts/memory" },
			{ label: "Skills", slug: "concepts/skills" },
			{ label: "Auxiliary agents", slug: "concepts/auxiliary-agents" },
			{ label: "Architecture", slug: "reference/architecture" },
		],
	},
	{
		label: "Reference",
		items: [
			{ label: "Web UI", slug: "concepts/web-ui" },
			{ label: "CLI and operations", slug: "guides/cli-operations" },
			{ label: "Configuration", slug: "reference/configuration" },
			{ label: "Responses API", slug: "reference/responses-api" },
		],
	},
];
