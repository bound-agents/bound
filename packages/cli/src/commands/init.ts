// Task 2: bound init command
// Interactive config generation with presets

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

export interface InitArgs {
	ollama?: boolean;
	anthropic?: boolean;
	bedrock?: boolean;
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
	let provider: "ollama" | "anthropic" | "bedrock" = "ollama";
	let baseUrl = "http://localhost:11434";
	let apiKey: string | undefined;
	let region: string | undefined;
	let model = "llama3";

	// Determine configuration mode
	if (args.ollama) {
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

	const modelBackendsConfig = {
		backends: [backendConfig],
		default: provider,
	};

	// Write config files
	writeFileSync(allowlistPath, JSON.stringify(allowlistConfig, null, 2) + "\n");
	writeFileSync(modelBackendsPath, JSON.stringify(modelBackendsConfig, null, 2) + "\n");

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

	// Create optional config templates if requested
	if (args.withSync) {
		const syncPath = resolve(configDir, "sync.json");
		const syncConfig = {
			hub: "primary-host",
			sync_interval_seconds: 30,
		};
		writeFileSync(syncPath, JSON.stringify(syncConfig, null, 2) + "\n");
		console.log(`  - ${configDir}/sync.json (template)`);
	}

	if (args.withMcp) {
		const mcpPath = resolve(configDir, "mcp.json");
		const mcpConfig = {
			servers: [],
		};
		writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
		console.log(`  - ${configDir}/mcp.json (template)`);
	}

	if (args.withOverlay) {
		const overlayPath = resolve(configDir, "overlay.json");
		const overlayConfig = {
			mounts: {},
		};
		writeFileSync(overlayPath, JSON.stringify(overlayConfig, null, 2) + "\n");
		console.log(`  - ${configDir}/overlay.json (template)`);
	}
}
