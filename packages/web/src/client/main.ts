import { mount } from "svelte";
import App from "./App.svelte";

const appContainer = document.getElementById("app");
if (!appContainer) {
	throw new Error("App container not found");
}

mount(App, { target: appContainer });
