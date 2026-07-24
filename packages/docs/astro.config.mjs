// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Deployed as a GitHub Pages *project site* at
// https://bound-agents.github.io/bound/ — so the base path is the repo name.
// Astro bakes `base` into every asset/link URL at build time; if the repo
// slug ever changes, update `site` + `base` together here.
export default defineConfig({
	site: "https://bound-agents.github.io",
	base: "/bound/",
	integrations: [
		starlight({
			title: "Bound",
			description: "A personal agent that maintains state across multiple hosts.",
			customCss: ["./src/styles/theme.css"],
			head: [
				{
					tag: "link",
					attrs: {
						rel: "preconnect",
						href: "https://fonts.googleapis.com",
					},
				},
				{
					tag: "link",
					attrs: {
						rel: "preconnect",
						href: "https://fonts.gstatic.com",
						crossorigin: "",
					},
				},
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
					},
				},
			],
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/bound-agents/bound",
				},
			],
			sidebar: [
				{
					label: "Start Here",
					items: [{ label: "Introduction", slug: "index" }],
				},
				{
					label: "Guides",
					items: [
						{ label: "Quick Start", slug: "guides/quick-start" },
						{ label: "Boundless", slug: "guides/boundless" },
						{ label: "Multi-Host Setup", slug: "guides/multi-host" },
						{ label: "MCP Servers", slug: "guides/mcp-servers" },
						{ label: "Webhooks", slug: "guides/webhooks" },
						{ label: "RSS Feeds", slug: "guides/rss-feeds" },
						{ label: "CLI & Operations", slug: "guides/cli-operations" },
					],
				},
				{
					label: "Concepts",
					items: [
						{ label: "Web UI Tour", slug: "concepts/web-ui" },
						{ label: "Agent System", slug: "concepts/agent-system" },
						{ label: "Sync & Multi-Host", slug: "concepts/sync" },
						{ label: "Sandbox & Filesystem", slug: "concepts/sandbox" },
						{ label: "Inference & Model Routing", slug: "concepts/inference" },
						{ label: "Memory & Knowledge Graph", slug: "concepts/memory" },
						{ label: "Skills", slug: "concepts/skills" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "Architecture", slug: "reference/architecture" },
						{ label: "Configuration", slug: "reference/configuration" },
					],
				},
			],
		}),
	],
});
