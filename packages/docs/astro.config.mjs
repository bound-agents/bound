// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { sidebar } from "./src/sidebar";

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
			sidebar,
		}),
	],
});
