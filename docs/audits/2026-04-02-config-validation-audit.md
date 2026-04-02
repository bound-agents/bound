# Config Loading and Validation Edge Cases Audit

**Date**: 2026-04-02
**Auditor**: Claude (Sonnet 4.5)
**Scope**: Config loading, validation, hot-reload mechanisms, and edge cases

## Executive Summary

Identified **12 issues** across 4 severity levels:
- **CRITICAL**: 3 issues (MCP transport validation, config reload dead code, duplicate backend IDs)
- **HIGH**: 4 issues (persona.md DoS, empty file handling, env var edge cases, URL scheme validation)
- **MEDIUM**: 3 issues (circular reference handling, optional config error propagation, z.record key validation)
- **LOW**: 2 issues (cron schedule syntax validation, overlay mount path validation)

## Critical Issues

### 1. MCP Schema Missing Transport-Specific Validation
**File**: `packages/shared/src/config-schemas.ts:161-174`
**Severity**: CRITICAL

The `mcpSchema` allows `transport: "stdio"` without requiring `command`, and `transport: "http"` without requiring `url`. This will cause runtime failures when MCP servers attempt to connect.

```typescript
export const mcpSchema = z.object({
	servers: z.array(
		z.object({
			name: z.string().min(1),
			command: z.string().optional(),  // ❌ Should be required for stdio
			url: z.string().optional(),      // ❌ Should be required for http
			transport: z.enum(["stdio", "http"]),
			// ...
		}),
	),
});
```

**Impact**: Invalid MCP configs pass validation and fail at runtime.

**Recommendation**: Add a `.refine()` or `.superRefine()` to enforce:
```typescript
.refine(
	(server) => {
		if (server.transport === "stdio") return server.command !== undefined;
		if (server.transport === "http") return server.url !== undefined;
		return true;
	},
	{
		message: "stdio transport requires 'command', http transport requires 'url'",
	}
)
```

---

### 2. Config Reload Dead Code
**Files**:
- `packages/cli/src/commands/config-reload.ts:72-98`
- `packages/cli/src/commands/start.ts` (no monitoring code)

**Severity**: CRITICAL

The `boundctl config reload mcp` command writes `config_reload_requested` to `cluster_config` table, but **no code monitors this flag**. The orchestrator never polls or acts on it.

```typescript
// config-reload.ts:72-98
// Write config_reload_requested entry to cluster_config
const key = "config_reload_requested";
// ... writes to cluster_config + change_log
console.log("Configuration reload requested successfully.");
console.log("The orchestrator will pick up the change on next poll.");  // ❌ LIE
```

**Impact**: Operators believe they can hot-reload MCP configs, but changes never take effect until full restart.

**Recommendation**: Either:
1. Implement actual monitoring in `start.ts` (poll `cluster_config` every N seconds), OR
2. Remove the command entirely and document that MCP changes require restart

---

### 3. No Duplicate Backend ID Validation
**File**: `packages/shared/src/config-schemas.ts:59-89`
**Severity**: CRITICAL

The `modelBackendsSchema` checks that `default` references a valid backend, but **does not check for duplicate backend IDs**. Multiple backends with `id: "claude"` will pass validation but cause unpredictable routing behavior.

```typescript
export const modelBackendsSchema = z
	.object({
		backends: z.array(modelBackendSchema).min(0),
		default: z.string().default(""),
		// ...
	})
	.refine(/* checks default exists */)
	.refine(/* checks ollama/openai have base_url */);
	// ❌ Missing: check for duplicate backend IDs
```

**Impact**: Silent data corruption. First/last backend wins depending on iteration order.

**Recommendation**: Add validation:
```typescript
.refine(
	(data) => {
		const ids = data.backends.map((b) => b.id);
		return ids.length === new Set(ids).size;
	},
	{ message: "backend IDs must be unique" }
)
```

---

## High Severity Issues

### 4. Persona.md Denial of Service
**Files**:
- `packages/agent/src/context-assembly.ts:78-99`
- `packages/cli/src/commands/start.ts:480-493`

**Severity**: HIGH

Both files read `persona.md` with `readFileSync()` with **no size limit**. A malicious or accidental multi-gigabyte persona file will:
1. Consume all memory
2. Block the event loop during read
3. Be injected into every LLM call (token limit failures)

```typescript
// context-assembly.ts:87
const content = readFileSync(personaPath, "utf-8");
personaCache = content;  // ❌ Unbounded size
```

**Impact**: Single file can DoS the entire agent loop.

**Recommendation**: Add size limit (e.g., 100KB):
```typescript
const MAX_PERSONA_SIZE = 100 * 1024; // 100KB
const stats = statSync(personaPath);
if (stats.size > MAX_PERSONA_SIZE) {
	throw new Error(`persona.md exceeds ${MAX_PERSONA_SIZE} byte limit`);
}
const content = readFileSync(personaPath, "utf-8");
```

---

### 5. Empty File Handling
**File**: `packages/core/src/config-loader.ts:85-162`
**Severity**: HIGH

`loadConfigFile()` calls `JSON.parse(content)` on empty or whitespace-only files, which throws `SyntaxError: Unexpected end of JSON input`. The error is caught, but the error message is generic.

```typescript
// config-loader.ts:92-93
const content = readFileSync(path, "utf-8");
const parsed = JSON.parse(content);  // ❌ Throws on empty file
```

Testing confirms:
```
$ echo "" > test.json
$ node -e "JSON.parse(require('fs').readFileSync('test.json', 'utf-8'))"
Error: Unexpected end of JSON input
```

**Impact**: Confusing error messages for operators. "Invalid JSON: Unexpected end of JSON input" doesn't indicate the file is empty.

**Recommendation**: Pre-check for empty content:
```typescript
const content = readFileSync(path, "utf-8").trim();
if (content === "") {
	return err({
		filename,
		message: "Config file is empty",
		fieldErrors: {},
	});
}
const parsed = JSON.parse(content);
```

---

### 6. Environment Variable Expansion Edge Cases
**File**: `packages/core/src/config-loader.ts:55-66`
**Severity**: HIGH

The `expandEnvVars()` regex `/\$\{([^:}]+)(?::-([^}]*))?\}/g` has several edge cases:

1. **Nested expansions**: `${VAR1:-${VAR2:-default}}` matches the outer braces, treats `${VAR2:-default}` as the default value (literal string, not expanded).
2. **Empty var name**: `${:-default}` matches, passes empty string to `process.env[""]` (always undefined), uses default.
3. **Unclosed braces**: `${VAR` doesn't match, passes through as-is (silent failure).
4. **Colons in defaults**: `${PORT:-http://localhost:8080}` splits on first `:-`, works correctly.

**Impact**:
- Nested expansion silently fails (produces literal string)
- Unclosed braces pass through undetected (may break JSON parsing)

**Recommendation**: Add validation:
```typescript
export function expandEnvVars(value: string): string {
	// Pre-check for unclosed braces
	const openBraces = (value.match(/\$\{/g) || []).length;
	const closeBraces = (value.match(/\}/g) || []).length;
	if (openBraces !== closeBraces) {
		throw new Error("Unclosed environment variable expansion");
	}

	return value.replace(/\$\{([^:}]+)(?::-([^}]*))?\}/g, (_match, varName, defaultVal) => {
		if (!varName || varName.trim() === "") {
			throw new Error("Empty environment variable name in expansion");
		}
		const envValue = process.env[varName];
		if (envValue !== undefined) {
			return envValue;
		}
		if (defaultVal !== undefined) {
			// Recursively expand defaults to support nesting
			return expandEnvVars(defaultVal);
		}
		throw new Error(`Environment variable ${varName} is not defined and no default provided`);
	});
}
```

---

### 7. URL Validation Accepts Non-HTTP Schemes
**File**: `packages/shared/src/config-schemas.ts:46,154`
**Severity**: HIGH

The schema uses `z.string().url()` which accepts **any** valid URL scheme (including `file://`, `ftp://`, `javascript://`, etc.).

```typescript
// Line 46
base_url: z.string().url().optional(),  // ❌ Accepts file://, ftp://, etc.

// Line 154
url: z.string().url(),  // ❌ Same issue for keyring
```

**Impact**: Potential SSRF or file disclosure if base_url accepts `file:///etc/passwd`.

**Recommendation**: Use `.refine()` to enforce http/https:
```typescript
base_url: z
	.string()
	.url()
	.refine((val) => val.startsWith("http://") || val.startsWith("https://"), {
		message: "URL must use http or https scheme",
	})
	.optional(),
```

---

## Medium Severity Issues

### 8. Circular Object References in expandEnvVarsInObject
**File**: `packages/core/src/config-loader.ts:68-83`
**Severity**: MEDIUM

The `expandEnvVarsInObject()` function recursively walks objects without tracking visited nodes. A malicious JSON with circular references (via prototype pollution or manual construction) will cause stack overflow.

```typescript
function expandEnvVarsInObject(obj: unknown): unknown {
	// ...
	if (obj !== null && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = expandEnvVarsInObject(value);  // ❌ No cycle detection
		}
		return result;
	}
	return obj;
}
```

**Impact**: Rare but possible. JSON.parse() itself prevents most circular refs, but prototype pollution or deeply nested objects could still cause issues.

**Recommendation**: Add depth limit:
```typescript
function expandEnvVarsInObject(obj: unknown, depth = 0): unknown {
	const MAX_DEPTH = 100;
	if (depth > MAX_DEPTH) {
		throw new Error("Config object exceeds maximum nesting depth");
	}
	// ... existing logic, pass depth+1 to recursive calls
}
```

---

### 9. Optional Config Error Propagation
**File**: `packages/core/src/config-loader.ts:197-229`
**Severity**: MEDIUM

The `loadOptionalConfigs()` function silently excludes "File not found" errors but **includes validation errors**. However, callers don't consistently check for `result.ok === false` before accessing the config.

```typescript
// config-loader.ts:220-225
const result = loadConfigFile(configDir, filename, schema);
if (result.ok || !result.error?.message.includes("File not found")) {
	// Include both successful loads and actual validation errors
	// Exclude only "file not found" errors (missing optional files are OK)
	configs[key] = result as Result<Record<string, unknown>, ConfigError>;
}
```

**Impact**: If an optional config has a validation error, it's stored in `optionalConfig.X` as an error result. Callers that don't check `.ok` will access `.value` on an error result (undefined).

**Example**: `packages/cli/src/commands/start.ts:339` accesses `appContext.optionalConfig.mcp` and checks `.ok`, but many other locations (lines 377, 417, 567, etc.) may not.

**Recommendation**: Audit all `optionalConfig` access sites and ensure `.ok` is checked, OR change `loadOptionalConfigs()` to log validation errors and exclude them (treat as missing).

---

### 10. z.record() Accepts Arbitrary Keys
**File**: `packages/shared/src/config-schemas.ts` (multiple locations)
**Severity**: MEDIUM

Several schemas use `z.record(z.string(), ...)` which accepts **any string** as a key, including:
- Empty strings
- Very long strings (DoS via memory)
- Special characters (`__proto__`, `constructor`, etc. for prototype pollution)

```typescript
// Line 7
platforms: z.record(z.string(), z.string()).optional(),

// Line 179
mounts: z.record(z.string(), z.string()),

// Line 184
export const cronSchedulesSchema = z.record(z.string(), ...)
```

**Impact**:
- Overlay mounts with empty keys: `/` → `""`
- Cron schedules with million-character keys: memory exhaustion
- Prototype pollution (mitigated by JSON.parse, but worth documenting)

**Recommendation**: Add key validation:
```typescript
const safeKeySchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);

// For overlay mounts (paths)
const pathKeySchema = z.string().min(1).max(4096).regex(/^\/[^\x00]*$/);

// Use in schemas:
mounts: z.record(pathKeySchema, z.string()),
```

---

## Low Severity Issues

### 11. Cron Schedule Syntax Not Validated
**File**: `packages/shared/src/config-schemas.ts:184-194`
**Severity**: LOW

The `cronSchedulesSchema` accepts any non-empty string for `schedule`, but doesn't validate cron syntax. Invalid cron expressions will be accepted at config load time and fail later during scheduling.

```typescript
z.object({
	schedule: z.string().min(1),  // ❌ "not-a-cron-expression" passes
	// ...
})
```

**Impact**: Delayed error detection. Invalid cron schedules are discovered at runtime, not config load time.

**Recommendation**: Add cron syntax validation using a library like `cron-parser` or a regex:
```typescript
import { parseExpression } from "cron-parser";

schedule: z.string().min(1).refine(
	(val) => {
		try {
			parseExpression(val);
			return true;
		} catch {
			return false;
		}
	},
	{ message: "Invalid cron expression" }
),
```

---

### 12. Overlay Mount Paths Not Validated
**File**: `packages/shared/src/config-schemas.ts:178-180`
**Severity**: LOW

The `overlaySchema` accepts any string-to-string mapping for `mounts`. There's no validation that:
1. Keys are valid filesystem paths
2. Values are valid filesystem paths
3. Paths don't escape the sandbox (e.g., `../../etc/passwd`)

```typescript
export const overlaySchema = z.object({
	mounts: z.record(z.string(), z.string()),  // ❌ No path validation
});
```

**Impact**: Invalid paths fail at runtime during overlay mount. Security risk if paths can escape sandbox.

**Recommendation**: Add path validation:
```typescript
const absolutePathSchema = z.string().regex(/^\/[^\x00]*$/, "Must be absolute path");
const noTraversalSchema = absolutePathSchema.refine(
	(path) => !path.includes(".."),
	{ message: "Path traversal not allowed" }
);

export const overlaySchema = z.object({
	mounts: z.record(noTraversalSchema, noTraversalSchema),
});
```

---

## Additional Observations

### Config Hot-Reload Status
**Finding**: The `boundctl config reload` command writes to `cluster_config` but **is never monitored by the orchestrator**. This appears to be incomplete implementation.

**Files**:
- `packages/cli/src/commands/config-reload.ts` (writes flag)
- `packages/cli/src/commands/start.ts` (no monitoring code)

**Impact**: Command exists but does nothing. Operators may expect hot-reload capability that doesn't work.

**Recommendation**: Document that config changes require restart, or implement actual monitoring.

---

### Persona Caching
**Finding**: `packages/agent/src/context-assembly.ts:70-99` caches persona content in module-level variables. The cache is never invalidated.

```typescript
let personaCache: string | null = null;
let personaCachePath: string | null = null;
```

**Impact**: Changes to `persona.md` require full process restart. This is consistent with other config files, but should be documented.

**Recommendation**: Document in comments that persona changes require restart.

---

## Testing Recommendations

1. **Add edge case tests** to `packages/core/src/__tests__/config-loader.test.ts`:
   - Empty file
   - Whitespace-only file
   - Nested env var expansion
   - Unclosed braces in env vars
   - Empty env var name
   - Circular object references (depth limit)
   - Very large files (persona.md size limit)

2. **Add schema validation tests** to `packages/shared/src/__tests__/config-schemas.test.ts`:
   - MCP stdio without command
   - MCP http without url
   - Duplicate backend IDs
   - Invalid URL schemes (file://, ftp://)
   - Invalid cron expressions
   - Path traversal in overlay mounts
   - Empty keys in z.record fields

3. **Add integration tests** for config reload:
   - Verify that `boundctl config reload mcp` actually reloads MCP servers
   - Test race conditions if reload is implemented
   - Test behavior when reload is requested during active agent loop

---

## Summary of Recommendations

| Priority | Issue | Action |
|----------|-------|--------|
| **CRITICAL** | MCP transport validation | Add `.refine()` to check stdio→command, http→url |
| **CRITICAL** | Config reload dead code | Implement monitoring OR remove command |
| **CRITICAL** | Duplicate backend IDs | Add uniqueness check in schema |
| **HIGH** | Persona.md DoS | Add 100KB size limit |
| **HIGH** | Empty file handling | Pre-check for empty content, better error message |
| **HIGH** | Env var edge cases | Validate brace matching, support nested expansion |
| **HIGH** | URL scheme validation | Restrict to http/https only |
| **MEDIUM** | Circular references | Add depth limit to expandEnvVarsInObject |
| **MEDIUM** | Optional config errors | Audit all access sites, ensure `.ok` checks |
| **MEDIUM** | z.record key validation | Add length/regex constraints to record keys |
| **LOW** | Cron syntax validation | Use cron-parser to validate at load time |
| **LOW** | Overlay path validation | Add path format + traversal checks |

---

## Files Audited

- `packages/core/src/config-loader.ts` (230 lines)
- `packages/shared/src/config-schemas.ts` (222 lines)
- `packages/agent/src/context-assembly.ts` (persona loading)
- `packages/cli/src/commands/start.ts` (persona loading)
- `packages/cli/src/commands/config-reload.ts` (107 lines)
- `packages/core/src/__tests__/config-loader.test.ts` (partial review)

Total lines audited: ~900 lines across 6 files.
