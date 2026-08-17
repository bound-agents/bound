import RELEASE_SYNC from "@jitl/quickjs-singlefile-cjs-release-sync";
import { type QuickJSHandle, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

// One singleton module per daemon process, matching getQuickJS()'s old
// behavior while using a bundle-safe variant. Individual Yard invocations
// still receive fresh runtimes + contexts below.
let bundleSafeQuickJSPromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
function getBundleSafeQuickJS(): ReturnType<typeof newQuickJSWASMModuleFromVariant> {
	bundleSafeQuickJSPromise ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
	return bundleSafeQuickJSPromise;
}

/**
 * Yard driver — slice 1 of the Yard design plan (/home/user VFS:
 * yard-design-plan.md): QuickJS runtime lifecycle, guest bootstrap with
 * branded effect constructors, and the yield → validate → dispatch → resume
 * generator loop.
 *
 * The unit boundary is the `YardHost` seam: the driver knows how to run a
 * bounded guest program and hand validated effect payloads outward, but has no
 * knowledge of Bound's tool registry, model router, aux system, or trace
 * persistence. Those arrive in the wiring slice (native `yard` tool), which
 * implements `YardHost` over the existing dispatch paths.
 *
 * Guest execution model (see the design plan, "Execution"):
 * - fresh runtime + context per run; no ambient I/O, module, or process APIs
 *   (QuickJS bare context provides none; dynamic code compilation is refused
 *   by the bootstrap hardening below);
 * - the program must define `function* main(input)`;
 * - constructors (`tool`, `infer`, `aux`, `all`, `sequence`) build immutable
 *   branded effect descriptions — a private Symbol captured only by the
 *   bootstrap closure marks them, so plain effect-shaped objects are rejected
 *   at the yield boundary;
 * - every value crossing the boundary rides the strict JSON bridge, both
 *   directions;
 * - guest CPU is interrupt-limited per entry (`cpuSliceMs`) — host awaits
 *   between entries don't count against the guest.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface YardInferenceRequest {
	prompt: string;
	input?: JsonValue;
	schema?: JsonValue;
	max_tokens?: number;
}

/**
 * The dispatch seam. The wiring slice implements this over the unified tool
 * registry (tool effects) and the ModelRouter (inference effects). Rejections
 * are thrown back into the guest generator as sanitized structured errors.
 */
export interface YardHost {
	dispatchTool(name: string, args: JsonValue): Promise<unknown>;
	dispatchInference(model: string, request: YardInferenceRequest): Promise<unknown>;
}

/**
 * Implementation safety ceilings — NOT Yard tool parameters (design plan,
 * "Execution"). Overridable in tests; the shipped tool uses the defaults.
 */
export interface YardLimits {
	memoryLimitBytes: number;
	stackSizeBytes: number;
	/** Max uninterrupted guest CPU per entry into the VM. */
	cpuSliceMs: number;
	maxSourceBytes: number;
	/** Max bytes for any single JSON value crossing the guest boundary. */
	maxBridgeBytes: number;
}

export const DEFAULT_YARD_LIMITS: YardLimits = {
	memoryLimitBytes: 128 * 1024 * 1024,
	stackSizeBytes: 1024 * 1024,
	cpuSliceMs: 2_000,
	maxSourceBytes: 512 * 1024,
	maxBridgeBytes: 4 * 1024 * 1024,
};

export interface YardUsage {
	tool_calls: number;
	inference_calls: number;
	/** Populated by the wiring slice once inference dispatch reports usage. */
	inference_tokens: number;
	elapsed_ms: number;
}

export interface YardRunResult {
	result: JsonValue;
	usage: YardUsage;
}

export interface RunYardProgramOptions {
	/** Complete `function* main(input) { ... }` definition. */
	program: string;
	/** JSON-compatible value exposed to the program as `input`. */
	input?: JsonValue;
	host: YardHost;
	limits?: Partial<YardLimits>;
}

/** Validated effect payload copied out of the guest (known fields only). */
export type YardEffectPayload =
	| { kind: "tool"; name: string; args: JsonValue }
	| { kind: "inference"; model: string; request: YardInferenceRequest }
	| {
			kind: "all";
			children: YardEffectPayload[];
			options?: { concurrency?: number; errors?: "fail-fast" | "settled" };
	  }
	| { kind: "sequence"; children: YardEffectPayload[] };

/**
 * Guest bootstrap. Evaluated once per context, before the program. Returns the
 * step function the host drives the generator through. The effect brand is a
 * private Symbol captured only by this closure — never exposed on globalThis —
 * so effects can only be constructed through the injected constructors.
 */
const BOOTSTRAP_SOURCE = `(() => {
	"use strict";
	const BRAND = Symbol("yard.effect");

	// Dynamic code compilation is disabled (design plan, "Execution").
	// Best-effort within the guest realm; the JSON bridge and host-side
	// payload validation remain the actual boundary.
	const refuse = function () { throw new Error("dynamic code compilation is disabled in Yard"); };
	try { globalThis.eval = refuse; } catch (e) {}
	try { globalThis.Function = refuse; } catch (e) {}
	try { Object.defineProperty(Object.getPrototypeOf(function () {}), "constructor", { value: refuse }); } catch (e) {}
	try { Object.defineProperty(Object.getPrototypeOf(function* () {}), "constructor", { value: refuse }); } catch (e) {}

	// No ambient clock or randomness (design plan, "Execution"). QuickJS ships
	// Date and Math.random in a bare context; remove the clock, make the RNG
	// refuse. Both run BEFORE the freeze pass below locks Math and the global
	// bindings.
	try { delete globalThis.Date; } catch (e) {}
	if (typeof globalThis.Date !== "undefined") {
		try { Object.defineProperty(globalThis, "Date", { value: undefined, writable: false, configurable: false }); } catch (e) {}
	}
	try { Math.random = function () { throw new Error("randomness is disabled in Yard"); }; } catch (e) {}

	// Freeze intrinsic prototypes and constructors (design plan, "Execution").
	// This is what makes the bridge trustworthy from inside the realm: shared
	// prototypes cannot be polluted across the program's own modules, JSON (the
	// serialization the step reply rides) cannot be swapped or monkey-patched,
	// and a toJSON planted on Object.prototype cannot rewrite a validated
	// effect payload between the brand check and the bridge copy. Sloppy-mode
	// guest writes to frozen targets fail SILENTLY (no throw), so ordinary
	// programs are unaffected; only the pollution itself stops taking effect.
	// globalThis stays extensible — the program must still define main() and
	// its own top-level bindings; guest-created objects and prototypes stay
	// fully writable.
	const intrinsicNames = [
		"Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "BigInt",
		"Math", "JSON", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
		"ReferenceError", "EvalError", "URIError", "AggregateError", "InternalError",
		"Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry",
		"ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
		"Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
		"Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
		"Reflect", "Proxy", "eval", "isFinite", "isNaN", "parseInt", "parseFloat",
		"decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
	];
	for (const name of intrinsicNames) {
		const value = globalThis[name];
		if (value === undefined || value === null || value === globalThis) continue;
		try {
			if (typeof value === "function" || typeof value === "object") {
				if (value.prototype) Object.freeze(value.prototype);
				Object.freeze(value);
			}
		} catch (e) {}
		try { Object.defineProperty(globalThis, name, { value: value, writable: false, configurable: false }); } catch (e) {}
	}
	// The real %Function.prototype% is no longer reachable via the (replaced)
	// Function binding; freeze it directly, plus the generator machinery the
	// step loop itself depends on.
	try { Object.freeze(Object.getPrototypeOf(function () {})); } catch (e) {}
	try {
		const genFnProto = Object.getPrototypeOf(function* () {});
		Object.freeze(genFnProto.prototype);
		Object.freeze(genFnProto);
	} catch (e) {}

	const deepFreeze = (value) => {
		if (value === null || typeof value !== "object") return value;
		Object.freeze(value);
		for (const key of Object.getOwnPropertyNames(value)) {
			const child = value[key];
			if (child !== null && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
		}
		return value;
	};

	const assertJsonCompatible = (value, what) => {
		const t = typeof value;
		if (value === null || t === "boolean" || t === "string") return;
		if (t === "number") {
			if (!isFinite(value)) throw new Error(what + " must be JSON-compatible (non-finite number)");
			return;
		}
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) assertJsonCompatible(value[i], what);
			return;
		}
		if (t === "object") {
			for (const key of Object.keys(value)) assertJsonCompatible(value[key], what);
			return;
		}
		throw new Error(what + " must be JSON-compatible (found " + t + ")");
	};

	const brand = (payload) => {
		Object.defineProperty(payload, BRAND, {
			value: true,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		return deepFreeze(payload);
	};
	const isEffect = (value) => value !== null && typeof value === "object" && value[BRAND] === true;

	const toolCtor = (name, args) => {
		if (typeof name !== "string" || name.length === 0) {
			throw new TypeError("tool() requires a tool name string");
		}
		const a = args === undefined ? {} : args;
		assertJsonCompatible(a, "tool() args");
		return brand({ kind: "tool", name: name, args: a });
	};

	const inferCtor = (model, request) => {
		if (typeof model !== "string" || model.length === 0) {
			throw new TypeError("infer() requires an explicit model id string");
		}
		if (request === null || typeof request !== "object" || Array.isArray(request)) {
			throw new TypeError("infer() requires a request object");
		}
		if (typeof request.prompt !== "string") {
			throw new TypeError("infer() request requires a prompt string");
		}
		// Same interpolation trap as aux() instructions: pass structured data
		// through request.input, or JSON.stringify() it into the prompt.
		if (request.prompt.indexOf("[object Object]") !== -1) {
			throw new TypeError(
				'infer() prompt contains "[object Object]" - a structured value was interpolated into a template string and its content was lost. Pass structured data via request.input, or JSON.stringify() it.',
			);
		}
		assertJsonCompatible(request, "infer() request");
		return brand({ kind: "inference", model: model, request: request });
	};

	const auxCtor = (name, instructions, options) => {
		if (typeof name !== "string" || name.length === 0) {
			throw new TypeError("aux() requires an identity name string");
		}
		if (typeof instructions !== "string" || instructions.length === 0) {
			throw new TypeError("aux() requires instructions");
		}
		// Interpolating a structured value into a template string coerces it to
		// the literal "[object Object]" and the receiving agent gets no data at
		// all (live incident: two review objects handed to a remediation agent
		// as "[object Object]" - it saw no findings and no-oped). Fail loudly at
		// construction, where the program can still fix the interpolation.
		if (instructions.indexOf("[object Object]") !== -1) {
			throw new TypeError(
				'aux() instructions contain "[object Object]" - a structured value was interpolated into a template string and its content was lost. JSON.stringify() the value (or extract the fields you need) before embedding it.',
			);
		}
		const extra = options === undefined ? {} : options;
		return toolCtor("aux", Object.assign({ action: "invoke", name: name, instructions: instructions }, extra));
	};

	const validateChildren = (effects, ctor) => {
		if (!Array.isArray(effects)) throw new TypeError(ctor + " requires an array of effects");
		for (const e of effects) {
			if (!isEffect(e)) {
				throw new TypeError(
					ctor + " accepts only branded effects created by tool()/infer()/aux()/all()/sequence()",
				);
			}
		}
	};

	const allCtor = (effects, options) => {
		validateChildren(effects, "all()");
		const opts = options === undefined ? {} : options;
		if (opts.errors !== undefined && opts.errors !== "fail-fast" && opts.errors !== "settled") {
			throw new TypeError('all() errors option must be "fail-fast" or "settled"');
		}
		if (opts.concurrency !== undefined && (typeof opts.concurrency !== "number" || opts.concurrency < 1)) {
			throw new TypeError("all() concurrency must be a number >= 1");
		}
		return brand({
			kind: "all",
			children: effects.slice(),
			options: { concurrency: opts.concurrency, errors: opts.errors },
		});
	};

	const sequenceCtor = (effects) => {
		validateChildren(effects, "sequence()");
		return brand({ kind: "sequence", children: effects.slice() });
	};

	for (const entry of [
		["tool", toolCtor],
		["infer", inferCtor],
		["aux", auxCtor],
		["all", allCtor],
		["sequence", sequenceCtor],
	]) {
		Object.defineProperty(globalThis, entry[0], {
			value: entry[1],
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}

	// Copy only the known payload fields outward (design plan, "Effects").
	const serializeEffect = (value) => {
		if (!isEffect(value)) {
			throw new Error(
				"yielded value is not a branded effect — construct effects with tool()/infer()/aux()/all()/sequence()",
			);
		}
		if (value.kind === "tool") return { kind: "tool", name: value.name, args: value.args };
		if (value.kind === "inference") return { kind: "inference", model: value.model, request: value.request };
		if (value.kind === "all") {
			return { kind: "all", children: value.children.map(serializeEffect), options: value.options };
		}
		if (value.kind === "sequence") {
			return { kind: "sequence", children: value.children.map(serializeEffect) };
		}
		throw new Error("unknown effect kind: " + value.kind);
	};

	const advance = (r) => {
		if (r.done) {
			const result = r.value === undefined ? null : r.value;
			assertJsonCompatible(result, "return value");
			return JSON.stringify({ done: true, result: result });
		}
		return JSON.stringify({ done: false, effect: serializeEffect(r.value) });
	};

	let gen = null;
	return (op, json) => {
		if (op === "start") {
			const main = globalThis.main;
			if (typeof main !== "function") {
				throw new Error('program must define "function* main(input)" at top level');
			}
			const inputValue = json === undefined ? undefined : deepFreeze(JSON.parse(json));
			try {
				Object.defineProperty(globalThis, "input", { value: inputValue, enumerable: false });
			} catch (e) {}
			gen = main(inputValue);
			if (gen === null || typeof gen !== "object" || typeof gen.next !== "function" || typeof gen.throw !== "function") {
				throw new Error('"main" must be a generator function: function* main(input) { ... }');
			}
			return advance(gen.next());
		}
		if (op === "next") return advance(gen.next(json === undefined ? undefined : JSON.parse(json)));
		if (op === "throw") {
			const info = JSON.parse(json);
			const err = new Error(info.message);
			// defineProperty, not assignment: Error.prototype is frozen by the
			// hardening pass above, so under "use strict" a plain assignment to
			// err.name hits the override mistake (assignment through a
			// non-writable prototype property throws) - defineProperty creates
			// the own property without consulting the prototype.
			Object.defineProperty(err, "name", {
				value: info.name || "YardEffectError",
				writable: true,
				configurable: true,
			});
			return advance(gen.throw(err));
		}
		throw new Error("unknown step op: " + op);
	};
})()`;

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Host-side defense-in-depth over the guest-serialized payload. The guest
 * bootstrap already constructs these shapes, but the host must not trust guest
 * memory — schema/capability/model validation beyond shape belongs to the
 * wiring slice's YardHost implementation.
 */
function validateEffectPayload(value: unknown, depth = 0): YardEffectPayload {
	if (depth > 8) throw new Error("effect nesting exceeds the supported depth");
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("effect payload must be an object");
	}
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case "tool": {
			if (typeof record.name !== "string" || record.name.length === 0) {
				throw new Error("tool effect requires a name");
			}
			return { kind: "tool", name: record.name, args: (record.args ?? {}) as JsonValue };
		}
		case "inference": {
			if (typeof record.model !== "string" || record.model.length === 0) {
				throw new Error("inference effect requires an explicit model id");
			}
			const request = record.request;
			if (request === null || typeof request !== "object" || Array.isArray(request)) {
				throw new Error("inference effect requires a request object");
			}
			if (typeof (request as Record<string, unknown>).prompt !== "string") {
				throw new Error("inference request requires a prompt string");
			}
			return {
				kind: "inference",
				model: record.model,
				request: request as unknown as YardInferenceRequest,
			};
		}
		case "all": {
			if (!Array.isArray(record.children)) throw new Error("all effect requires children");
			const options = (record.options ?? {}) as Record<string, unknown>;
			const errors = options.errors;
			if (errors !== undefined && errors !== "fail-fast" && errors !== "settled") {
				throw new Error('all effect errors option must be "fail-fast" or "settled"');
			}
			const concurrency = options.concurrency;
			if (concurrency !== undefined && (typeof concurrency !== "number" || concurrency < 1)) {
				throw new Error("all effect concurrency must be a number >= 1");
			}
			return {
				kind: "all",
				children: record.children.map((c) => validateEffectPayload(c, depth + 1)),
				options: { concurrency: concurrency as number | undefined, errors },
			};
		}
		case "sequence": {
			if (!Array.isArray(record.children)) throw new Error("sequence effect requires children");
			return {
				kind: "sequence",
				children: record.children.map((c) => validateEffectPayload(c, depth + 1)),
			};
		}
		default:
			throw new Error(`unknown effect kind: ${String(record.kind)}`);
	}
}

/** Run children with a concurrency cap, preserving input order in the results. */
async function mapWithConcurrency(
	items: YardEffectPayload[],
	limit: number,
	run: (item: YardEffectPayload) => Promise<unknown>,
	settled: boolean,
): Promise<unknown[]> {
	const results: unknown[] = new Array(items.length);
	let nextIndex = 0;
	let failed = false;
	let failure: unknown;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: workerCount }, async () => {
		for (;;) {
			if (failed && !settled) return;
			const i = nextIndex++;
			if (i >= items.length) return;
			try {
				const value = await run(items[i] as YardEffectPayload);
				results[i] = settled ? { status: "fulfilled", value } : value;
			} catch (err) {
				if (settled) {
					results[i] = { status: "rejected", reason: errorMessage(err) };
				} else if (!failed) {
					failed = true;
					failure = err;
					return;
				}
			}
		}
	});
	await Promise.all(workers);
	if (failed && !settled) {
		throw failure instanceof Error ? failure : new Error(String(failure));
	}
	return results;
}

/** Dispatch a validated effect. Only leaf effects touch the host seam. */
async function dispatchEffect(
	payload: YardEffectPayload,
	host: YardHost,
	usage: YardUsage,
): Promise<unknown> {
	switch (payload.kind) {
		case "tool":
			usage.tool_calls += 1;
			return host.dispatchTool(payload.name, payload.args);
		case "inference":
			usage.inference_calls += 1;
			return host.dispatchInference(payload.model, payload.request);
		case "all": {
			const settled = payload.options?.errors === "settled";
			const limit = payload.options?.concurrency ?? payload.children.length;
			return mapWithConcurrency(
				payload.children,
				limit,
				(child) => dispatchEffect(child, host, usage),
				settled,
			);
		}
		case "sequence": {
			const out: unknown[] = [];
			for (const child of payload.children) {
				out.push(await dispatchEffect(child, host, usage));
			}
			return out;
		}
	}
}

interface StepReply {
	done: boolean;
	result?: JsonValue;
	effect?: unknown;
}

/**
 * Execute a Yard guest program to completion against the supplied host seam.
 * Fresh QuickJS runtime + context per call; everything is disposed on the way
 * out regardless of outcome.
 */
export async function runYardProgram(options: RunYardProgramOptions): Promise<YardRunResult> {
	const limits: YardLimits = { ...DEFAULT_YARD_LIMITS, ...options.limits };
	const sourceBytes = Buffer.byteLength(options.program, "utf8");
	if (sourceBytes > limits.maxSourceBytes) {
		throw new Error(
			`program source is ${sourceBytes} bytes; the limit is ${limits.maxSourceBytes} bytes`,
		);
	}

	const startedAt = Date.now();
	const usage: YardUsage = {
		tool_calls: 0,
		inference_calls: 0,
		inference_tokens: 0,
		elapsed_ms: 0,
	};

	// The default quickjs-emscripten RELEASE_SYNC variant loads a separate
	// emscripten-module.wasm at runtime. That works from node_modules but fails
	// in the standalone bound binary (`/$bunfs/root/emscripten-module.wasm`
	// ENOENT). Memoize the published single-file release-sync variant instead:
	// its WASM bytes are embedded in the JS module, so Bun bundles the complete
	// runtime into the executable with no sidecar.
	const QuickJS = await getBundleSafeQuickJS();
	const runtime = QuickJS.newRuntime();
	runtime.setMemoryLimit(limits.memoryLimitBytes);
	runtime.setMaxStackSize(limits.stackSizeBytes);

	// Guest CPU deadline: armed only while guest code runs; host awaits between
	// entries don't count. The interrupt handler is polled by QuickJS during
	// guest execution.
	let deadlineAt = Number.POSITIVE_INFINITY;
	runtime.setInterruptHandler(() => Date.now() > deadlineAt);

	const vm = runtime.newContext();
	let stepFn: QuickJSHandle | undefined;

	const unwrapGuest = (
		result: { value: QuickJSHandle } | { error: QuickJSHandle },
		stage: string,
	): QuickJSHandle => {
		if ("error" in result) {
			const dumped: unknown = vm.dump(result.error);
			result.error.dispose();
			const message =
				dumped !== null && typeof dumped === "object" && "message" in dumped
					? String((dumped as { message: unknown }).message)
					: String(dumped);
			throw new Error(`Yard ${stage} failed: ${message}`);
		}
		return result.value;
	};

	const enterGuest = <T>(fn: () => T): T => {
		deadlineAt = Date.now() + limits.cpuSliceMs;
		try {
			return fn();
		} finally {
			deadlineAt = Number.POSITIVE_INFINITY;
		}
	};

	const callStep = (op: string, json: string | undefined, stage: string): StepReply => {
		if (json !== undefined && Buffer.byteLength(json, "utf8") > limits.maxBridgeBytes) {
			throw new Error(`value crossing the Yard boundary exceeds ${limits.maxBridgeBytes} bytes`);
		}
		const opHandle = vm.newString(op);
		const jsonHandle = json === undefined ? vm.undefined : vm.newString(json);
		try {
			const fn = stepFn;
			if (!fn) throw new Error("Yard bootstrap is not initialized");
			const replyHandle = unwrapGuest(
				enterGuest(() => vm.callFunction(fn, vm.undefined, opHandle, jsonHandle)),
				stage,
			);
			const replyJson = vm.getString(replyHandle);
			replyHandle.dispose();
			if (Buffer.byteLength(replyJson, "utf8") > limits.maxBridgeBytes) {
				throw new Error(`value crossing the Yard boundary exceeds ${limits.maxBridgeBytes} bytes`);
			}
			return JSON.parse(replyJson) as StepReply;
		} finally {
			opHandle.dispose();
			if (jsonHandle !== vm.undefined) jsonHandle.dispose();
		}
	};

	try {
		stepFn = unwrapGuest(vm.evalCode(BOOTSTRAP_SOURCE, "yard-bootstrap.js"), "bootstrap");

		const programResult = unwrapGuest(
			enterGuest(() => vm.evalCode(options.program, "yard-program.js")),
			"program evaluation",
		);
		programResult.dispose();

		let reply = callStep(
			"start",
			options.input === undefined ? undefined : JSON.stringify(options.input),
			"start",
		);

		while (!reply.done) {
			const payload = validateEffectPayload(reply.effect);
			let op: "next" | "throw";
			let json: string;
			try {
				const value = await dispatchEffect(payload, options.host, usage);
				const serialized = JSON.stringify(value === undefined ? null : value);
				if (serialized === undefined) {
					throw new Error("dispatched result is not JSON-compatible");
				}
				op = "next";
				json = serialized;
			} catch (err) {
				op = "throw";
				json = JSON.stringify({ message: errorMessage(err), name: "YardEffectError" });
			}
			reply = callStep(op, json, "step");
		}

		usage.elapsed_ms = Date.now() - startedAt;
		return { result: (reply.result ?? null) as JsonValue, usage };
	} finally {
		stepFn?.dispose();
		vm.dispose();
		runtime.dispose();
	}
}
