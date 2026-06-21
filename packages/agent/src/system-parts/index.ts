/**
 * Stage 6 ASSEMBLY — static system parts builder.
 *
 * Builds the byte-stable static portion of `systemPrompt`:
 *   1. Environment paragraph (constant)
 *   2. Concurrency paragraph (constant)
 *   3. Persona body (from the synced `cluster_config['persona']` row)
 *   4. Orientation block (commandRegistry + host identity)
 *   5. `## Database Schema` block (live `PRAGMA table_info` snapshot)
 *
 * The skill body injection that follows in production code is NOT
 * part of this module — it depends on per-turn task payload lookup
 * and lives at the assembleContext call site.
 *
 * **Byte-stability is the load-bearing invariant.** This output
 * sits inside the system-level cache breakpoint per R-VC25; bytes
 * MUST be byte-identical across cold rebuilds when the underlying
 * inputs (configDir, commandRegistry, hostName, siteId, schema)
 * haven't changed. The drift detector at
 * `validation/run-stable-prefix-drift-validation.ts` would surface
 * a regression here as a "leak in compose" finding.
 *
 * Properties pinned by `__tests__/static-parts.property.test.ts`:
 *
 *   Y1 Determinism — same inputs produce byte-equal output.
 *   Y2 Section ordering — env, concurrency, persona?, orientation,
 *      schema? in fixed order.
 *   Y3 Orientation command sort-stability — commands render
 *      alphabetically regardless of input order.
 *   Y4 Empty registry → no MCP commands subsection.
 *   Y5 Persona absent → persona slot omitted entirely.
 *   Y6 Schema block omits zero-column tables.
 */

export {
	buildStaticSystemParts,
	ENVIRONMENT_PARAGRAPH,
	CONCURRENCY_PARAGRAPH,
	type BuildStaticSystemPartsParams,
} from "./build";
