// App-side entry for the MCP Apps task-board test server (sibling server.ts
// bundles this file into the UI resource at startup). This is the iframe side
// of the MCP Apps postMessage protocol: it runs inside the bound web UI's
// single-origin opaque-origin sandbox, talks to the host AppBridge via
// PostMessageTransport, and is the moving part we use to exercise the
// multi-turn app->model loop end to end.
//
// Multi-turn surface exercised, both directions:
//   - ontoolinput          host -> app: initial { title, tasks } render
//   - onhostcontextchanged host -> app: theme / display-mode follow
//   - updateModelContext   app  -> host: STAGE state silently (checkbox toggle).
//                          The host folds this into a thread message so the
//                          NEXT model turn sees current state, without forcing
//                          a turn now (formatAppContentToMessage path).
//   - sendMessage          app  -> host: FORCE a model turn now (add task /
//                          "ask assistant"). The host injects it as a thread
//                          message and drives the next turn.
//   - requestDisplayMode   app  -> host: inline <-> fullscreen toggle.
import { App, PostMessageTransport, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";

interface Task {
	text: string;
	done: boolean;
}

const app = new App({ name: "task-board-app", version: "1.0.0" }, {});

let title = "Tasks";
let tasks: Task[] = [];
let displayMode: "inline" | "fullscreen" = "inline";

const root = () => document.getElementById("root") as HTMLDivElement;

/** A readable, model-facing snapshot of the board's current state. */
function boardSnapshot(): string {
	const lines = tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.text}`);
	const doneCount = tasks.filter((t) => t.done).length;
	return [`Task board "${title}" — ${doneCount}/${tasks.length} done:`, ...lines].join("\n");
}

/** Stage current state for the next turn without forcing one (checkbox path). */
function stageState(): void {
	void app.updateModelContext({
		content: [{ type: "text", text: boardSnapshot() }],
	});
}

/** Force a model turn now with an explicit user-intent line (button path). */
function notify(intent: string): void {
	void app.sendMessage({
		role: "user",
		content: [{ type: "text", text: `${intent}\n\n${boardSnapshot()}` }],
	});
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	Object.assign(node, props);
	for (const child of children) {
		node.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

function render(): void {
	const container = root();
	if (!container) return;
	container.replaceChildren();

	const header = el("div", { className: "tb-header" }, [
		el("h1", { className: "tb-title", textContent: title }),
		el("button", {
			className: "tb-mode",
			textContent: displayMode === "fullscreen" ? "Collapse" : "Expand",
			onclick: () => {
				const next = displayMode === "fullscreen" ? "inline" : "fullscreen";
				void app.requestDisplayMode({ mode: next });
			},
		}),
	]);

	const list = el("ul", { className: "tb-list" });
	if (tasks.length === 0) {
		list.append(el("li", { className: "tb-empty", textContent: "No tasks yet — add one below." }));
	}
	tasks.forEach((task, index) => {
		const checkbox = el("input", { type: "checkbox", checked: task.done });
		checkbox.addEventListener("change", () => {
			tasks[index].done = checkbox.checked;
			stageState(); // silent: next turn sees it, no forced turn
			render();
		});
		const label = el("label", { className: task.done ? "tb-item tb-done" : "tb-item" }, [
			checkbox,
			el("span", { textContent: task.text }),
		]);
		list.append(el("li", {}, [label]));
	});

	const input = el("input", {
		className: "tb-input",
		type: "text",
		placeholder: "Add a task and press Enter…",
	});
	const addTask = () => {
		const text = input.value.trim();
		if (!text) return;
		tasks.push({ text, done: false });
		input.value = "";
		render();
		notify(`I added a task: "${text}".`); // forces a turn
	};
	input.addEventListener("keydown", (e) => {
		if ((e as KeyboardEvent).key === "Enter") addTask();
	});

	const askButton = el("button", {
		className: "tb-ask",
		textContent: "Ask the assistant about these tasks",
		onclick: () => notify("Here's my current task board — what should I focus on?"),
	});

	container.append(
		header,
		list,
		el("div", { className: "tb-add" }, [
			input,
			el("button", { className: "tb-addbtn", textContent: "Add", onclick: addTask }),
		]),
		askButton,
	);
}

// host -> app: initial tool arguments. Render the board the model asked for.
app.ontoolinput = (params) => {
	const args = (params.arguments ?? {}) as { title?: string; tasks?: unknown };
	title = typeof args.title === "string" && args.title.trim() ? args.title : "Tasks";
	tasks = Array.isArray(args.tasks)
		? args.tasks.map((t) => {
				if (typeof t === "string") return { text: t, done: false };
				const obj = (t ?? {}) as { text?: unknown; done?: unknown };
				return { text: String(obj.text ?? ""), done: obj.done === true };
			})
		: [];
	render();
};

// host -> app: theme / display-mode changes ride here after init and on toggle.
app.onhostcontextchanged = (ctx) => {
	if (ctx.theme) applyDocumentTheme(ctx.theme);
	if (ctx.displayMode === "inline" || ctx.displayMode === "fullscreen") {
		displayMode = ctx.displayMode;
		render();
	}
};

// Fire-and-forget: handlers above are registered before connect, so the app
// is ready for the init handshake. Not awaited because an IIFE bundle has no
// top-level await.
void app.connect(new PostMessageTransport(window.parent, window.parent));
