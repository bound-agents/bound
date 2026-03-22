import { writable } from "svelte/store";

export const currentRoute = writable("/");

export function navigateTo(route: string): void {
	window.location.hash = route;
}
