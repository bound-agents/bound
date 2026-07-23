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
						{ label: "CLI & Operations", slug: "guides/cli-operations" },
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
