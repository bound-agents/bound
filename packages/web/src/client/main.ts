import App from "./App.svelte";

const appContainer = document.getElementById("app");
if (!appContainer) {
	throw new Error("App container not found");
}

const app = new App({
	target: appContainer,
});

export default app;
