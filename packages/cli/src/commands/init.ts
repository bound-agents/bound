// Task 2: bound init command
// Interactive config generation with presets

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

export interface InitArgs {
	ollama?: boolean;
	anthropic?: boolean;
	bedrock?: boolean;
	cerebras?: boolean;
	zai?: boolean;
	/** Hub-only mode: no local inference backends; the node relays inference to spokes. */
	hub?: boolean;
	region?: string;
	name?: string;
	withSync?: boolean;
	withMcp?: boolean;
	withOverlay?: boolean;
	force?: boolean;
	configDir?: string;
}

export async function runInit(args: InitArgs): Promise<void> {
	const configDir = args.configDir || "config";

	// Check if config already exists
	const allowlistPath = resolve(configDir, "allowlist.json");
	const modelBackendsPath = resolve(configDir, "model_backends.json");

	if (!args.force && (existsSync(allowlistPath) || existsSync(modelBackendsPath))) {
		console.log("Config already exists. Use --force to overwrite.");
		process.exit(0);
	}

	// Create config directory
	mkdirSync(configDir, { recursive: true });

	const operatorName = args.name || process.env.USER || "operator";
	let provider: "ollama" | "anthropic" | "bedrock" | "cerebras" | "zai" = "ollama";
	let baseUrl = "http://localhost:11434";
	let apiKey: string | undefined;
	let region: string | undefined;
	let model = "llama3";

	// Determine configuration mode
	if (args.hub) {
		// Hub-only mode: no local inference. The node acts as a relay hub and
		// proxies LLM calls to spokes that have inference backends configured.
		// No provider/model selection needed.
	} else if (args.ollama) {
		// Ollama preset
		provider = "ollama";
		baseUrl = "http://localhost:11434";
		model = "llama3";
	} else if (args.anthropic) {
		// Anthropic preset
		provider = "anthropic";
		model = "claude-3-5-sonnet-20241022";
		apiKey = process.env.ANTHROPIC_API_KEY;

		if (!apiKey) {
			console.log("ANTHROPIC_API_KEY not found in environment.");
		}
	} else if (args.bedrock) {
		// Bedrock preset
		provider = "bedrock";
		region = args.region || "us-east-1";
		model = "anthropic.claude-3-5-sonnet-20241022-v2:0";
	} else if (args.cerebras) {
		// Cerebras preset
		provider = "cerebras";
		baseUrl = "https://api.cerebras.ai/v1";
		model = "llama-4-scout-17b-16e-instruct";
		apiKey = process.env.CEREBRAS_API_KEY;

		if (!apiKey) {
			console.log("CEREBRAS_API_KEY not found in environment.");
		}
	} else if (args.zai) {
		// z.AI preset (subscription-based, prices stay at 0)
		provider = "zai";
		baseUrl = "https://api.z.ai/api/coding/paas/v4";
		model = "glm-4.7";
		apiKey = process.env.ZAI_API_KEY;

		if (!apiKey) {
			console.log("ZAI_API_KEY not found in environment.");
		}
	}

	// Generate deterministic UUID for operator
	deterministicUUID(BOUND_NAMESPACE, operatorName);

	// Create allowlist.json
	const allowlistConfig = {
		default_web_user: operatorName,
		users: {
			[operatorName]: {
				display_name: operatorName,
			},
		},
	};

	// Create model_backends.json
	let modelBackendsConfig: { backends: unknown[]; default: string };
	if (args.hub) {
		// Hub-only: no inference backends. Inference is relayed to spokes.
		modelBackendsConfig = { backends: [], default: "" };
	} else {
		// biome-ignore lint/suspicious/noExplicitAny: config is dynamic
		const backendConfig: any = {
			id: provider,
			provider,
			model,
			context_window: 8192,
			tier: 3,
		};

		if (baseUrl && provider !== "anthropic" && provider !== "bedrock") {
			backendConfig.base_url = baseUrl;
		}

		if (apiKey) {
			backendConfig.api_key = apiKey;
		}

		if (region) {
			backendConfig.region = region;
		}

		modelBackendsConfig = {
			backends: [backendConfig],
			default: provider,
		};
	}

	// Write config files
	writeFileSync(allowlistPath, `${JSON.stringify(allowlistConfig, null, 2)}\n`);
	writeFileSync(modelBackendsPath, `${JSON.stringify(modelBackendsConfig, null, 2)}\n`);

	if (args.hub) {
		console.log(`
Hub initialized successfully!

Created:
  - ${configDir}/allowlist.json
  - ${configDir}/model_backends.json (empty — hub relays inference to spokes)

Operator: ${operatorName}

Next steps:
  1. Configure keyring.json with spoke public keys
  2. Configure sync.json with this hub's URL (or leave blank — hub doesn't point to another hub)
  3. Set BIND_HOST=0.0.0.0 so spokes can reach this host
  4. Run: bound start
  5. On each spoke: set sync.hub to this host's URL and add this hub to keyring.json
`);
	} else {
		console.log(`
Config initialized successfully!

Created:
  - ${configDir}/allowlist.json
  - ${configDir}/model_backends.json

Operator: ${operatorName}
Provider: ${provider}
Model: ${model}

Next steps:
  1. Review the config files
  2. Run: bound start
  3. Open http://localhost:3000 in your browser
`);
	}

	// Create optional config templates if requested
	if (args.withSync) {
		const syncPath = resolve(configDir, "sync.json");
		const syncConfig = {
			hub: "primary-host",
			sync_interval_seconds: 30,
		};
		writeFileSync(syncPath, `${JSON.stringify(syncConfig, null, 2)}\n`);
		console.log(`  - ${configDir}/sync.json (template)`);
	}

	if (args.withMcp) {
		const mcpPath = resolve(configDir, "mcp.json");
		const mcpConfig = {
			servers: [],
		};
		writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
		console.log(`  - ${configDir}/mcp.json (template)`);
	}

	if (args.withOverlay) {
		const overlayPath = resolve(configDir, "overlay.json");
		const overlayConfig = {
			mounts: {},
		};
		writeFileSync(overlayPath, `${JSON.stringify(overlayConfig, null, 2)}\n`);
		console.log(`  - ${configDir}/overlay.json (template)`);
	}
}
