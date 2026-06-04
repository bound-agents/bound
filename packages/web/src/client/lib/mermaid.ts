// Client-side Mermaid diagram rendering.
//
// The markdown layer (lib/markdown.ts) carves `mermaid`-fenced code blocks out
// of the syntax-highlight path and emits a `<pre class="mermaid">` carrier whose
// text content is the raw diagram source. This module turns those carriers into
// rendered SVG after the HTML has been injected into the DOM via `{@html}`.
//
// Mermaid is dynamically imported on first use so its (substantial) bundle stays
// out of the initial page load — a conversation with no diagrams never pays for
// it. It is initialized once with `securityLevel: "strict"`, which makes mermaid
// sanitize its own SVG output (strips scripts, disables click bindings), so the
// generated SVG goes straight into the DOM without a second pass through
// DOMPurify.

type MermaidApi = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
let diagramCounter = 0;

async function getMermaid(): Promise<MermaidApi> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => {
			const mermaid = mod.default;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "dark",
				fontFamily: "inherit",
			});
			return mermaid;
		});
	}
	return mermaidPromise;
}

// Render every not-yet-processed `<pre class="mermaid">` descendant of `node`.
// Marks each block with `data-processed` so it is rendered at most once, and
// re-runs cleanly when `{@html}` replaces the container's content with fresh
// (unprocessed) carriers.
async function renderDiagrams(node: HTMLElement): Promise<void> {
	const blocks = node.querySelectorAll<HTMLElement>("pre.mermaid:not([data-processed])");
	if (blocks.length === 0) {
		return;
	}

	let mermaid: MermaidApi;
	try {
		mermaid = await getMermaid();
	} catch {
		// Dynamic import failed (offline, bundle error). Leave the source visible.
		return;
	}

	for (const block of blocks) {
		const source = block.textContent ?? "";
		// Mark before rendering so a re-entrant call (e.g. a rapid second update)
		// doesn't pick the same block up twice.
		block.setAttribute("data-processed", "true");
		if (!source.trim()) {
			continue;
		}
		const id = `mermaid-diagram-${diagramCounter++}`;
		try {
			const { svg } = await mermaid.render(id, source);
			block.innerHTML = svg;
			block.classList.add("mermaid-rendered");
		} catch (err) {
			// Invalid diagram syntax — keep the raw source on screen and surface the
			// reason on hover rather than blanking the block.
			block.classList.add("mermaid-error");
			block.setAttribute("title", err instanceof Error ? err.message : "Failed to render diagram");
		}
	}
}

/**
 * Svelte action for containers that render markdown via `{@html}`. Pass the
 * rendered-HTML string as the action parameter so the diagrams re-render
 * whenever the content changes.
 *
 * ```svelte
 * <div class="md-content" use:mermaid={renderedHtml}>{@html renderedHtml}</div>
 * ```
 */
export function mermaid(node: HTMLElement, _html?: unknown) {
	// Fire after the initial `{@html}` content is in the DOM.
	void renderDiagrams(node);
	return {
		update() {
			void renderDiagrams(node);
		},
	};
}
