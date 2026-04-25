import { mount } from "svelte";
import App from "./App.svelte";

const appContainer = document.getElementById("app");
if (!appContainer) {
	throw new Error("App container not found");
}

// Svelte 5's `mount` appends to the target rather than replacing its contents,
// so clear the pre-render loading splash first to avoid it overlaying the app.
appContainer.innerHTML = "";

mount(App, { target: appContainer });
