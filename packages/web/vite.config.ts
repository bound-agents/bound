import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [svelte()],
	root: ".",
	build: {
		outDir: "dist/client",
		emptyOutDir: true,
		minify: true,
	},
	server: {
		proxy: {
			"/api": "http://localhost:3000",
			"/ws": {
				target: "ws://localhost:3000",
				ws: true,
			},
		},
	},
});
