/**
 * CLI flag parsing for the agent-harness diagnostic.
 *
 * No env vars are consulted — every knob is a flag. `--budget` is required
 * (no default) so cost is always a deliberate operator decision.
 *
 * Conventions:
 *  - Flags use `--name value` form. `--name=value` is also accepted.
 *  - `--help` / `-h` prints usage and exits 0.
 *  - Unknown flags exit with a parse error (no silent acceptance).
 *  - Positional arguments are not accepted.
 */

export interface HarnessArgs {
	/** Hard ceiling in USD; required, no default. */
	budget: number;
	/** Path to the directory containing `model_backends.json`. */
	configDir: string;
	/** Backend ID from `model_backends.json` to drive. Empty string → router default. */
	backend: string;
	/** Fixture name; required. */
	fixture: string;
	/** Diagnostic plugin names (comma-separated input becomes an array). */
	diagnostics: string[];
	/** Number of turns to drive. */
	turns: number;
	/** Pino log level for `AppContext.logger`. */
	logLevel: "silent" | "trace" | "debug" | "info" | "warn" | "error" | "fatal";
	/** If set, write each turn's wire bodies to `<dumpWire>/turn-N.json`. */
	dumpWire: string | null;
}

const USAGE = `\
Usage: bun run packages/agent/scripts/agent-harness/run.ts [flags]

Required:
  --budget <usd>            Hard ceiling in USD. No default. Bare invocation
                            without this fails.
  --fixture <name>          Fixture from fixtures/ to run.

Optional:
  --config-dir <path>       Directory containing model_backends.json.
                            Default: ./config
  --backend <id>            Backend ID from model_backends.json. Default: the
                            router's configured default.
  --diagnostic <names>      Comma-separated diagnostic plugin name(s) to run.
                            Default: cache
  --turns <n>               Number of turns to drive. Default: 5
  --log-level <level>       Pino level for AppContext.logger
                            (silent|trace|debug|info|warn|error|fatal).
                            Default: silent
  --dump-wire <path>        If set, write each turn's wire bodies to
                            <path>/turn-N.json for offline inspection.
  -h, --help                Print this message and exit.
`;

const VALID_LOG_LEVELS = new Set(["silent", "trace", "debug", "info", "warn", "error", "fatal"]);

/**
 * Parse argv into a HarnessArgs. On `--help` prints usage and exits 0.
 * On parse error prints a one-line message + usage and exits 2.
 */
export function parseArgs(argv: ReadonlyArray<string>): HarnessArgs {
	const out = {
		budget: undefined as number | undefined,
		configDir: "./config",
		backend: "",
		fixture: undefined as string | undefined,
		diagnostics: ["cache"],
		turns: 5,
		logLevel: "silent" as HarnessArgs["logLevel"],
		dumpWire: null as string | null,
	};

	const tokens: string[] = [];
	for (const a of argv) {
		const eq = a.indexOf("=");
		if (a.startsWith("--") && eq > 0) {
			tokens.push(a.slice(0, eq), a.slice(eq + 1));
		} else {
			tokens.push(a);
		}
	}

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--help" || tok === "-h") {
			process.stdout.write(USAGE);
			process.exit(0);
		}
		const next = (): string => {
			const v = tokens[i + 1];
			if (v === undefined || v.startsWith("--")) {
				fail(`flag ${tok} requires a value`);
			}
			i++;
			return v as string;
		};
		switch (tok) {
			case "--budget": {
				const v = Number(next());
				if (!Number.isFinite(v) || v <= 0) fail(`--budget must be a positive number, got ${v}`);
				out.budget = v;
				break;
			}
			case "--config-dir":
				out.configDir = next();
				break;
			case "--backend":
				out.backend = next();
				break;
			case "--fixture":
				out.fixture = next();
				break;
			case "--diagnostic":
				out.diagnostics = next()
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				if (out.diagnostics.length === 0) fail("--diagnostic must list at least one plugin");
				break;
			case "--turns": {
				const v = Number(next());
				if (!Number.isInteger(v) || v <= 0) fail(`--turns must be a positive integer, got ${v}`);
				out.turns = v;
				break;
			}
			case "--log-level": {
				const v = next();
				if (!VALID_LOG_LEVELS.has(v))
					fail(`--log-level must be one of ${[...VALID_LOG_LEVELS].join("|")}, got ${v}`);
				out.logLevel = v as HarnessArgs["logLevel"];
				break;
			}
			case "--dump-wire":
				out.dumpWire = next();
				break;
			default:
				fail(`unknown flag: ${tok}`);
		}
	}

	if (out.budget === undefined) fail("--budget is required (no default)");
	if (out.fixture === undefined) fail("--fixture is required");

	return {
		budget: out.budget as number,
		configDir: out.configDir,
		backend: out.backend,
		fixture: out.fixture as string,
		diagnostics: out.diagnostics,
		turns: out.turns,
		logLevel: out.logLevel,
		dumpWire: out.dumpWire,
	};
}

function fail(msg: string): never {
	process.stderr.write(`agent-harness: ${msg}\n\n${USAGE}`);
	process.exit(2);
}
