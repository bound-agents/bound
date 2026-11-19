/**
 * jsdom render harness for Svelte component tests.
 *
 * `installDom()` puts a jsdom window on globalThis, fakes `fetch` with a route
 * table, replaces `WebSocket` with a never-connecting fake, and stubs the
 * layout APIs jsdom lacks (ResizeObserver, IntersectionObserver, matchMedia,
 * scrollTo, scrollIntoView, canvas). `teardown()` unmounts every component and
 * restores every global it touched, so files that don't use the harness see
 * the runtime they expect.
 *
 * Typical use:
 *
 *   const dom = installDom();
 *   afterAll(() => dom.teardown());
 *   dom.route("GET", "/api/advisories/count", () => ({ count: 3 }));
 *   const { target } = await dom.mount(TopBar, {});
 *   await dom.settle();
 *   expect(target.textContent).toContain("3");
 *
 * Component imports must come after `installDom()` only when the module reads
 * `window` at import time; svelte components themselves do not.
 */

import { JSDOM, VirtualConsole } from "jsdom";

export type RouteRequest = {
	method: string;
	url: URL;
	path: string;
	body: unknown;
	headers: Headers;
};

export type RouteHandler = (
	request: RouteRequest,
) => unknown | Response | Promise<unknown | Response>;

export type RecordedRequest = { method: string; path: string; body: unknown };

type Mounted = { target: HTMLElement; component: Record<string, unknown> };

/** A WebSocket that never connects on its own. Tests drive it explicitly. */
export class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;
	readonly sent: string[] = [];
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	/** Test driver: complete the handshake. */
	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.({});
	}

	/** Test driver: deliver a server frame (objects are JSON-encoded). */
	receive(data: unknown): void {
		this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
	}
}

class NoopObserver {
	static instances: NoopObserver[] = [];
	readonly callback: (...args: unknown[]) => void;
	readonly observed: unknown[] = [];
	disconnected = false;
	constructor(callback: (...args: unknown[]) => void) {
		this.callback = callback;
		NoopObserver.instances.push(this);
	}
	observe(target: unknown): void {
		this.observed.push(target);
	}
	unobserve(): void {}
	disconnect(): void {
		this.disconnected = true;
	}
	takeRecords(): unknown[] {
		return [];
	}
}

export class FakeResizeObserver extends NoopObserver {}
export class FakeIntersectionObserver extends NoopObserver {}

/** Event constructors replaced with jsdom's, so `new Event(...)` dispatches into jsdom. */
const EVENT_CONSTRUCTORS = [
	"Event",
	"CustomEvent",
	"UIEvent",
	"MouseEvent",
	"KeyboardEvent",
	"InputEvent",
	"FocusEvent",
	"WheelEvent",
	"SubmitEvent",
	"DragEvent",
	"ClipboardEvent",
	"PopStateEvent",
	"HashChangeEvent",
	"MessageEvent",
	"ErrorEvent",
	"ProgressEvent",
	"CloseEvent",
	"StorageEvent",
] as const;

export interface DomHarness {
	readonly window: Window & typeof globalThis;
	readonly document: Document;
	/** Every fetch the components made, in order. */
	readonly requests: RecordedRequest[];
	/**
	 * Register a fake API route. `path` matches the URL pathname exactly, or a
	 * RegExp tested against it. Handlers return JSON-able data or a Response.
	 * Later registrations take precedence. Unmatched requests get a 404.
	 */
	route(method: string, path: string | RegExp, handler: RouteHandler): void;
	/** Mount a component into a fresh element under <body>, then settle. */
	mount(
		component: unknown,
		props?: Record<string, unknown>,
	): Promise<{ target: HTMLElement; component: Record<string, unknown>; unmount: () => void }>;
	/** Let effects, microtasks and pending fake fetches run to quiescence. */
	settle(rounds?: number): Promise<void>;
	/** Dispatch a jsdom event (bubbling) and settle. */
	fire(element: Element, type: string, init?: Record<string, unknown>): Promise<void>;
	/** Set an input/textarea/select value and fire `input` + `change`. */
	type(element: Element, value: string): Promise<void>;
	/** Navigate the hash router (`#/...`) and settle. */
	navigate(hash: string): Promise<void>;
	/** Unmount everything and restore globals. Idempotent. */
	teardown(): void;
}

/**
 * One jsdom window for the whole test process. svelte's client runtime caches
 * `window`, `document` and the Node/Element prototype getters the first time
 * it touches the DOM (init_operations) and never re-reads them. A fresh window
 * per test file would leave every later file rendering through the first
 * file's dead prototypes, so files share this window and teardown resets it
 * instead of closing it.
 */
let sharedDom: JSDOM | undefined;

function acquireDom(url: string): JSDOM {
	if (!sharedDom) {
		// jsdom reports unimplemented APIs (layout, navigation) on its console;
		// those are expected under test. Real script errors still throw.
		sharedDom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
			url,
			pretendToBeVisual: true,
			virtualConsole: new VirtualConsole(),
		});
	} else {
		sharedDom.reconfigure({ url });
		sharedDom.window.document.head.innerHTML = "";
		sharedDom.window.document.body.innerHTML = "";
		sharedDom.window.localStorage.clear();
		sharedDom.window.sessionStorage.clear();
	}
	return sharedDom;
}

export function installDom(options: { url?: string } = {}): DomHarness {
	const dom = acquireDom(options.url ?? "http://localhost/");
	const window = dom.window as unknown as Window & typeof globalThis;
	const global = globalThis as Record<string, unknown>;
	const saved = new Map<string, PropertyDescriptor | undefined>();

	const setGlobal = (key: string, value: unknown) => {
		if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			value,
			configurable: true,
			writable: true,
			enumerable: false,
		});
	};

	// Everything jsdom defines that Bun does not (Node, HTMLElement, document...).
	for (const key of Object.getOwnPropertyNames(window)) {
		if (key in globalThis || key.startsWith("_")) continue;
		const value = (window as unknown as Record<string, unknown>)[key];
		setGlobal(key, typeof value === "function" && /^[a-z]/.test(key) ? value.bind(window) : value);
	}
	setGlobal("window", window);
	setGlobal("self", window);
	setGlobal("document", window.document);
	setGlobal("navigator", window.navigator);
	setGlobal("location", window.location);
	setGlobal("localStorage", window.localStorage);
	setGlobal("sessionStorage", window.sessionStorage);
	setGlobal("getComputedStyle", window.getComputedStyle.bind(window));
	setGlobal("requestAnimationFrame", window.requestAnimationFrame.bind(window));
	setGlobal("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));
	for (const name of EVENT_CONSTRUCTORS) {
		const ctor = (window as unknown as Record<string, unknown>)[name];
		if (ctor) setGlobal(name, ctor);
	}

	FakeWebSocket.instances = [];
	NoopObserver.instances = [];
	setGlobal("WebSocket", FakeWebSocket);
	setGlobal("ResizeObserver", FakeResizeObserver);
	setGlobal("IntersectionObserver", FakeIntersectionObserver);
	Object.assign(window, {
		WebSocket: FakeWebSocket,
		ResizeObserver: FakeResizeObserver,
		IntersectionObserver: FakeIntersectionObserver,
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent: () => false,
		}),
		scrollTo() {},
		scrollBy() {},
	});
	setGlobal("matchMedia", window.matchMedia);
	const elementProto = window.Element.prototype as unknown as Record<string, unknown>;
	elementProto.scrollIntoView ??= () => {};
	elementProto.scrollTo ??= function scrollTo(this: Element, arg: unknown) {
		if (arg && typeof arg === "object" && "top" in arg) {
			(this as unknown as { scrollTop: number }).scrollTop = Number((arg as { top: number }).top);
		}
	};
	(window.HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () =>
		null;
	if (!window.navigator.clipboard) {
		const clipboardWrites: string[] = [];
		Object.defineProperty(window.navigator, "clipboard", {
			configurable: true,
			value: {
				writes: clipboardWrites,
				writeText: async (text: string) => {
					clipboardWrites.push(text);
				},
				readText: async () => clipboardWrites.at(-1) ?? "",
			},
		});
	}

	const routes: { method: string; path: string | RegExp; handler: RouteHandler }[] = [];
	const requests: RecordedRequest[] = [];
	setGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const raw = input instanceof Request ? input.url : String(input);
		const url = new URL(raw, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		let body: unknown = init?.body ?? undefined;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {
				/* leave as text */
			}
		}
		requests.push({ method, path: url.pathname + url.search, body });
		for (let i = routes.length - 1; i >= 0; i--) {
			const route = routes[i];
			if (route.method !== method) continue;
			const matches =
				typeof route.path === "string"
					? route.path === url.pathname
					: route.path.test(url.pathname);
			if (!matches) continue;
			const result = await route.handler({
				method,
				url,
				path: url.pathname,
				body,
				headers: new Headers(init?.headers),
			});
			if (result instanceof Response) return result;
			return new Response(JSON.stringify(result ?? null), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: `no fake route for ${method} ${url.pathname}` }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});
	});

	const mounted: Mounted[] = [];
	let tornDown = false;

	const svelte = () => import("svelte");
	// Resolved svelte module, captured on first mount so teardown can unmount
	// synchronously — before the jsdom window/globals are torn down. Deferring
	// the unmount to an async `import(...).then(...)` races global restoration:
	// svelte's effect-teardown dereferences `document`, which is gone by then.
	let svelteModule: Awaited<ReturnType<typeof svelte>> | null = null;

	const settle = async (rounds = 5) => {
		const { flushSync, tick } = await svelte();
		for (let i = 0; i < rounds; i++) {
			await tick();
			flushSync();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		flushSync();
	};

	const harness: DomHarness = {
		window,
		document: window.document,
		requests,
		route(method, path, handler) {
			routes.push({ method: method.toUpperCase(), path, handler });
		},
		async mount(component, props = {}) {
			const mod = await svelte();
			svelteModule = mod;
			const { mount, unmount } = mod;
			const target = window.document.createElement("div");
			window.document.body.appendChild(target);
			const instance = mount(component as Parameters<typeof mount>[0], {
				target,
				props,
			}) as Record<string, unknown>;
			const entry: Mounted = { target, component: instance };
			mounted.push(entry);
			await settle();
			return {
				target,
				component: instance,
				unmount: () => {
					const index = mounted.indexOf(entry);
					if (index === -1) return;
					mounted.splice(index, 1);
					unmount(instance);
					target.remove();
				},
			};
		},
		settle,
		async fire(element, type, init = {}) {
			const EventCtor = type.startsWith("key")
				? window.KeyboardEvent
				: type.startsWith("mouse") || type === "click" || type === "dblclick"
					? window.MouseEvent
					: type === "input"
						? window.InputEvent
						: type.startsWith("focus") || type === "blur"
							? window.FocusEvent
							: window.Event;
			element.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, ...init }));
			await settle();
		},
		async type(element, value) {
			(element as HTMLInputElement).value = value;
			element.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
			element.dispatchEvent(new window.Event("change", { bubbles: true }));
			await settle();
		},
		async navigate(hash) {
			window.location.hash = hash;
			window.dispatchEvent(new window.HashChangeEvent("hashchange"));
			await settle();
		},
		teardown() {
			if (tornDown) return;
			tornDown = true;
			// Unmount synchronously while jsdom globals are still live. svelte's
			// effect-teardown dereferences `document`; deferring to an async import
			// would race the global restoration below and throw "document is not
			// defined" as an unhandled rejection.
			const pending = mounted.splice(0);
			if (svelteModule) {
				for (const entry of pending) {
					try {
						svelteModule.unmount(entry.component);
					} catch {
						/* already gone */
					}
				}
			}
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete global[key];
			}
			saved.clear();
			window.document.body.innerHTML = "";
		},
	};
	return harness;
}
