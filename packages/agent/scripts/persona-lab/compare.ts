#!/usr/bin/env bun
/**
 * persona-lab/compare.ts — fast persona-iteration harness.
 *
 * Workflow: edit persona.md, then run this. Get a side-by-side across models.
 * Each (model x prompt) case runs through the real AgentLoop, so production
 * retry / backoff / empty-completion handling is exercised on the actual code
 * path rather than a stripped driver.
 *
 *   bun run packages/agent/scripts/persona-lab/compare.ts
 *   bun run .../compare.ts --models opus,gpt-5.5 --prompts colleague-acp
 *   bun run .../compare.ts --persona /tmp/alt.md --out /tmp/run.md
 *
 * Flags:
 *   --models        comma list of backend ids (default: opus,gpt-5.5)
 *   --prompts       comma list of prompt names to run (default: all)
 *   --persona       persona file path (default: ./persona.md, else .example)
 *   --seed          seed transcript json (default: ./seed.json, else .example)
 *   --prompts-file  prompts json (default: ./prompts.json, else .example)
 *   --config-dir    bound config dir holding model_backends.json
 *                   (default: $BOUND_CONFIG_DIR, else ~/bound/config)
 *   --out           also write the markdown report to this path
 *
 * Optional: a local fault-bands.json (gitignored; see fault-bands.example.json)
 * maps model id -> [low, high] input-token windows that reliably fault
 * server-side, used only to warn before a run wastes time. Absent = no warning.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	InMemoryTurnStateStore,
	applyMetricsSchema,
	applySchema,
	insertRow,
	loadConfigFile,
} from "@bound/core";
import { type ModelRouter, createModelRouter } from "@bound/llm";
import { type AppContext, type Logger, modelBackendsSchema } from "@bound/shared";
import { InMemoryFs } from "just-bash";
import { toRouterConfig } from "../../../cli/src/commands/start/inference";
import { AgentLoop } from "../../src/agent-loop";
import { insertThreadMessage } from "../../src/agent-loop-utils";

const HERE = dirname(fileURLToPath(import.meta.url));

const TURN_STATE_TTL_MS = 55 * 60 * 1000;
const ESTIMATED_PROMPT_OVERHEAD_TOK = 200;
const estTokens = (text: string) => Math.round(text.length / 4);

type FaultBands = Record<string, [low: number, high: number]>;

type SeedMessage = { role: "user" | "assistant"; content: string };
type SeedFile = { summary: string; messages: SeedMessage[] };
type Prompt = { name: string; text: string };
type TurnMetrics = { cost_usd: number | null; tokens_in: number | null; tokens_out: number | null };

type CaseResult = {
	modelId: string;
	prompt: string;
	wroteNew: boolean;
	threw: string;
	turns: TurnMetrics | null;
	text: string;
};

type Inputs = {
	persona: string;
	personaPath: string;
	seed: SeedFile;
	prompts: Prompt[];
	models: string[];
	personaTok: number;
	seedTok: number;
	configDir: string;
	faultBands: FaultBands;
	outPath: string | null;
};

type RawBackends = Extract<
	ReturnType<typeof loadConfigFile<typeof modelBackendsSchema>>,
	{ ok: true }
>["value"];

// --- arg parsing ------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			out[arg.slice(2)] = next;
			i++;
		} else {
			out[arg.slice(2)] = "true";
		}
	}
	return out;
}

const splitList = (csv: string) =>
	csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * Resolve a working copy if present, else fall back to the committed .example.
 * Working copies (persona.md, prompts.json, seed.json) are gitignored so the
 * repo carries only generic templates; local edits stay local.
 */
function resolveWithExample(override: string | undefined, base: string, example: string): string {
	if (override) return resolve(override);
	const working = join(HERE, base);
	return existsSync(working) ? working : join(HERE, example);
}

/**
 * Load optional fault bands from a local fault-bands.json. Absent file means
 * no fault-band warnings — the tool ships with no model-specific data baked in.
 */
function loadFaultBands(): FaultBands {
	const path = join(HERE, "fault-bands.json");
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as FaultBands;
}

function loadInputs(args: Record<string, string>): Inputs {
	const personaPath = resolveWithExample(args.persona, "persona.md", "persona.example.md");
	if (!existsSync(personaPath)) {
		console.error(
			`persona file not found: ${personaPath}\nCopy persona.example.md to persona.md and edit it.`,
		);
		process.exit(1);
	}
	const seedPath = resolveWithExample(args.seed, "seed.json", "seed.example.json");
	const promptsPath = resolveWithExample(
		args["prompts-file"],
		"prompts.json",
		"prompts.example.json",
	);

	const persona = readFileSync(personaPath, "utf8");
	const seed: SeedFile = JSON.parse(readFileSync(seedPath, "utf8"));
	const allPrompts: Prompt[] = JSON.parse(readFileSync(promptsPath, "utf8"));

	const promptFilter = args.prompts ? new Set(splitList(args.prompts)) : null;
	const prompts = promptFilter ? allPrompts.filter((p) => promptFilter.has(p.name)) : allPrompts;
	const models = splitList(args.models ?? "");
	if (models.length === 0) {
		console.error(
			"no models given. Pass --models <id,id,...> with backend ids from your model_backends.json.",
		);
		process.exit(1);
	}

	const configDir =
		args["config-dir"] ?? process.env.BOUND_CONFIG_DIR ?? `${process.env.HOME}/bound/config`;

	return {
		persona,
		personaPath,
		seed,
		prompts,
		models,
		personaTok: estTokens(persona),
		seedTok: seed.messages.reduce((sum, m) => sum + estTokens(m.content), 0),
		configDir,
		faultBands: loadFaultBands(),
		outPath: args.out ? resolve(args.out) : null,
	};
}

// --- harness plumbing -------------------------------------------------------

const silentLogger: Logger = {
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {},
	fatal() {},
	child() {
		return silentLogger;
	},
	isLevelEnabled() {
		return false;
	},
} as Logger;

function silentBus(): AppContext["eventBus"] {
	const noop = () => undefined;
	return {
		on: noop,
		off: noop,
		emit: noop,
		once: noop,
		removeAllListeners: noop,
	} as unknown as AppContext["eventBus"];
}

type SeededDb = {
	db: Database;
	siteId: string;
	userId: string;
	threadId: string;
	hostName: string;
};

/**
 * Build a fresh in-memory bound DB seeded with a user, a thread carrying the
 * persona + summary, and the synthetic conversation history. The next message
 * to insert is the prompt under test.
 */
function seedDatabase(
	persona: string,
	seed: SeedFile,
	modelId: string,
	promptName: string,
): SeededDb {
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);

	const siteId = randomUUID();
	const userId = randomUUID();
	const threadId = randomUUID();
	const hostName = `persona-lab-${modelId}-${promptName}`;
	const now = new Date().toISOString();

	insertRow(
		db,
		"users",
		{
			id: userId,
			display_name: "persona-lab",
			platform_ids: null,
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: userId,
			interface: "harness",
			host_origin: siteId,
			color: 0,
			title: "persona-lab",
			summary: seed.summary,
			summary_through: now,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
			model_hint: null,
		},
		siteId,
	);
	insertRow(db, "cluster_config", { key: "persona", value: persona, modified_at: now }, siteId);

	seed.messages.forEach((message, i) => {
		// Stamp history strictly before `now` so the prompt sorts last.
		const offsetMs = (seed.messages.length - i + 1) * 1000;
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: message.role,
				content: message.content,
				model_id: null,
				tool_name: null,
				host_origin: hostName,
				created_at: new Date(Date.parse(now) - offsetMs).toISOString(),
				modified_at: null,
				deleted: 0,
				exit_code: null,
				metadata: null,
			},
			siteId,
		);
	});

	return { db, siteId, userId, threadId, hostName };
}

function countAssistantMessages(db: Database): number {
	return (
		db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages WHERE role='assistant'").get()
			?.n ?? 0
	);
}

function latestAssistantText(db: Database): string {
	return (
		db
			.query<{ content: string }, []>(
				"SELECT content FROM messages WHERE role='assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get()?.content ?? "(empty)"
	);
}

function latestTurnMetrics(db: Database): TurnMetrics | null {
	return (
		db
			.query<TurnMetrics, []>(
				"SELECT cost_usd, tokens_in, tokens_out FROM turns ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get() ?? null
	);
}

// --- run one case -----------------------------------------------------------

async function runCase(
	rawBackends: RawBackends,
	persona: string,
	seed: SeedFile,
	modelId: string,
	prompt: Prompt,
): Promise<CaseResult> {
	const backend = rawBackends.backends.find((b) => b.id === modelId);
	if (!backend) {
		return {
			modelId,
			prompt: prompt.name,
			wroteNew: false,
			threw: `model id not in config: ${modelId}`,
			turns: null,
			text: "(skipped)",
		};
	}

	const router = createModelRouter(toRouterConfig({ backends: [backend], default: backend.id }), {
		logger: silentLogger,
	});
	const { db, siteId, userId, threadId, hostName } = seedDatabase(
		persona,
		seed,
		modelId,
		prompt.name,
	);
	insertThreadMessage(
		db,
		{ threadId, role: "user", content: prompt.text, hostOrigin: hostName },
		siteId,
	);

	const before = countAssistantMessages(db);
	const ctx = {
		db,
		config: { allowlist: { users: [userId] }, modelBackends: rawBackends },
		optionalConfig: {},
		eventBus: silentBus(),
		logger: silentLogger,
		siteId,
		hostName,
		turnStateStore: new InMemoryTurnStateStore(TURN_STATE_TTL_MS),
		commandRegistry: [],
		fs: new InMemoryFs(),
	} as unknown as AppContext;
	const sandbox = { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
	const loop = new AgentLoop(ctx, sandbox, router as ModelRouter, {
		threadId,
		userId,
		modelId,
		toolRegistry: new Map(),
	});

	let threw = "";
	try {
		await loop.run();
	} catch (e) {
		const err = e as { name?: string; message?: string };
		threw = `${err?.name}: ${err?.message?.slice?.(0, 200)}`;
	}

	const wroteNew = countAssistantMessages(db) > before;
	const text = wroteNew
		? latestAssistantText(db)
		: "(NO COMPLETION — no new assistant row written; server fault or empty turn)";
	const turns = latestTurnMetrics(db);
	db.close();

	return { modelId, prompt: prompt.name, wroteNew, threw, turns, text };
}

// --- reporting --------------------------------------------------------------

function buildReportHeader(inputs: Inputs): string[] {
	const { personaPath, personaTok, seedTok, models, prompts, faultBands } = inputs;
	const lines: string[] = [
		"# persona-lab comparison",
		`persona: ${personaPath} (~${personaTok} tok) | seed: ~${seedTok} tok | est input ~${personaTok + seedTok} tok`,
		`models: ${models.join(", ")} | prompts: ${prompts.map((p) => p.name).join(", ")}\n`,
	];
	const estInput = personaTok + seedTok + ESTIMATED_PROMPT_OVERHEAD_TOK;
	for (const modelId of models) {
		const band = faultBands[modelId];
		if (band && estInput >= band[0] && estInput <= band[1]) {
			lines.push(
				`> WARNING ${modelId}: est input ~${estInput} tok is inside known fault band ${band[0]}-${band[1]}; expect server faults. Trim persona/seed below ${band[0]}.`,
			);
		}
	}
	return lines;
}

function formatCase(r: CaseResult): string {
	const status = `\`wroteNew=${r.wroteNew}\`${r.threw ? ` threw=${r.threw}` : ""} | turns=${JSON.stringify(r.turns)}`;
	return `\n## ${r.modelId} / ${r.prompt}\n${status}\n\n${r.text}`;
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
	const inputs = loadInputs(parseArgs(process.argv.slice(2)));

	const rb = loadConfigFile(inputs.configDir, "model_backends.json", modelBackendsSchema);
	if (!rb.ok) throw rb.error;
	const rawBackends = rb.value;

	const lines = buildReportHeader(inputs);
	for (const line of lines) console.log(line);

	for (const prompt of inputs.prompts) {
		for (const modelId of inputs.models) {
			console.error(`running ${modelId}/${prompt.name}...`);
			const result = await runCase(rawBackends, inputs.persona, inputs.seed, modelId, prompt);
			const block = formatCase(result);
			lines.push(block);
			console.log(block);
		}
	}

	if (inputs.outPath) {
		writeFileSync(inputs.outPath, lines.join("\n"));
		console.error(`\nwrote ${inputs.outPath}`);
	}
}

await main();
