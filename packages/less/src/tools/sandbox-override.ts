/**
 * Per-thread, session-scoped sandbox OVERRIDE — the `/sandbox` TUI command's
 * backing store.
 *
 * The filesystem sandbox is resolved once at startup from `config.sandbox`
 * (see `resolveSandboxConfig`). An operator sometimes needs to loosen or
 * disable it for ONE thread — most sharply when working on the sandbox itself,
 * where the in-process backend can't nest inside the outer seatbelt. This
 * module holds that per-thread deviation.
 *
 * SECURITY CONTRACT — operator-only. The override is reachable ONLY from text
 * the user types into the boundless TUI (`/sandbox …`). It is deliberately NOT
 * a tool, a tool parameter, or an ACP method, so the model cannot widen its own
 * write confinement. The structural guarantee is the shape of what the tool
 * layer receives: {@link SandboxOverrideStore.resolverFor} hands the bash tool a
 * bare read-only FUNCTION (base config → effective config) with no mutation
 * surface and the target thread captured at creation. The store's mutators
 * (`set` / `clear` / `addWritablePath`) live only on the store instance the
 * boundless client process owns and the TUI dispatch calls — never on anything
 * that crosses into tool execution.
 *
 * SESSION-SCOPED. State lives in this process's memory keyed by thread ID. It
 * is never persisted: it resets when boundless restarts, `/attach` to a
 * different thread sees that thread's override (default none), and `/clear` (a
 * new thread) starts with none.
 *
 * Pure config math (SDK-free, like `./sandbox-policy`) so it loads and tests on
 * every platform.
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DISABLED_SANDBOX, type ResolvedSandboxConfig } from "./sandbox-policy";

/**
 * A thread's deviation from the configured sandbox default:
 * - `off` — run this thread's commands unsandboxed (removes the sandbox
 *   entirely, including the `.git` exec-surface read-only carve-out).
 * - `allow` — keep the sandbox on, but grant extra writable paths for this
 *   thread (the `.git` protection stays in force). Paths are already resolved
 *   to absolute/realpath form and validated to exist before landing here.
 *
 * Absence of an override (the store returns `undefined`) means "the configured
 * default" — there is no explicit `on` variant to store, because clearing IS
 * returning to default.
 */
export type SandboxOverride = { mode: "off" } | { mode: "allow"; writablePaths: string[] };

/** A read-only mapping from a base resolved config to the thread's effective one. */
export type SandboxResolver = (base: ResolvedSandboxConfig) => ResolvedSandboxConfig;

/**
 * Apply a thread's override to a base resolved config, returning the effective
 * config a command on that thread should spawn under. Pure — no I/O, no store.
 *
 * - no override → the base unchanged.
 * - `off` → {@link DISABLED_SANDBOX} (the explicit unsandboxed posture), so the
 *   downstream spawn decision takes the `unsandboxed` branch exactly as a
 *   `sandbox: false` config would.
 * - `allow` → the base with the extra writable paths unioned onto whatever the
 *   base already granted (de-duplicated, base order preserved then extras
 *   appended). Enabled/network/onUnavailable and the captured git worktree
 *   metadata are preserved, so the `.git` carve-out and worktree grants still
 *   hold.
 */
export function applySandboxOverride(
	base: ResolvedSandboxConfig,
	override: SandboxOverride | undefined,
): ResolvedSandboxConfig {
	if (!override) return base;
	if (override.mode === "off") return DISABLED_SANDBOX;
	const merged = [...base.writablePaths];
	for (const p of override.writablePaths) {
		if (!merged.includes(p)) merged.push(p);
	}
	return { ...base, writablePaths: merged };
}

/**
 * One-line HUD / notice description of an override's effect, or `null` when the
 * thread is at its configured default (nothing to flag). Phrasing is written to
 * stand out in a persistent indicator so a forgotten override is loud.
 */
export function describeSandboxOverride(override: SandboxOverride | undefined): string | null {
	if (!override) return null;
	if (override.mode === "off") return "sandbox OFF (commands run unsandboxed)";
	const n = override.writablePaths.length;
	return `sandbox loosened (+${n} writable path${n === 1 ? "" : "s"})`;
}

/** Discriminated outcome of resolving + validating a path for `/sandbox allow`. */
export type AddWritablePathResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * In-process holder of per-thread sandbox overrides. Owned by the boundless
 * client process; mutated ONLY by the TUI `/sandbox` dispatch. The bash tool
 * sees this store solely through {@link resolverFor}, which exposes no mutation.
 */
export class SandboxOverrideStore {
	private readonly overrides = new Map<string, SandboxOverride>();

	/** The thread's override, or `undefined` for the configured default. */
	get(threadId: string): SandboxOverride | undefined {
		return this.overrides.get(threadId);
	}

	/** Replace the thread's override wholesale (operator-only caller). */
	set(threadId: string, override: SandboxOverride): void {
		this.overrides.set(threadId, override);
	}

	/** Return the thread to the configured default by dropping any override. */
	clear(threadId: string): void {
		this.overrides.delete(threadId);
	}

	/**
	 * Resolve, realpath, and validate `path`, then append it to the thread's
	 * `allow` override (creating one if the thread had no override or was `off`
	 * — `allow` is the loosen posture, distinct from `off`). Repeatable. A
	 * non-existent path is rejected with a clear message and leaves the store
	 * untouched (no half-formed override).
	 */
	addWritablePath(
		threadId: string,
		path: string,
		cwd: string = process.cwd(),
	): AddWritablePathResult {
		const abs = isAbsolute(path) ? path : resolve(cwd, path);
		let resolved: string;
		try {
			// statSync first so a missing path yields the "does not exist" message
			// rather than realpath's lower-level ENOENT.
			if (!statSync(abs).isDirectory() && !statSync(abs).isFile()) {
				return { ok: false, error: `Path is neither a file nor a directory: ${abs}` };
			}
			resolved = realpathSync(abs);
		} catch {
			return {
				ok: false,
				error: `Path does not exist, so it cannot be made writable: ${abs}`,
			};
		}
		const existing = this.overrides.get(threadId);
		const basePaths = existing?.mode === "allow" ? existing.writablePaths : [];
		const writablePaths = basePaths.includes(resolved) ? basePaths : [...basePaths, resolved];
		this.overrides.set(threadId, { mode: "allow", writablePaths });
		return { ok: true, value: resolved };
	}

	/**
	 * Apply the thread's override to a base config. Used by the HUD and the
	 * `/sandbox` (no-arg) status readout where a one-off resolution is enough.
	 */
	resolve(threadId: string, base: ResolvedSandboxConfig): ResolvedSandboxConfig {
		return applySandboxOverride(base, this.overrides.get(threadId));
	}

	/**
	 * A read-only resolver for one thread, captured at creation. This is the ONLY
	 * thing the bash tool layer is ever handed: a bare function with no mutation
	 * methods, and a fixed thread it cannot retarget. Each call reads the live
	 * override for that thread, so a `/sandbox` change takes effect on the next
	 * command without rebuilding the tool set.
	 */
	resolverFor(threadId: string): SandboxResolver {
		return (base: ResolvedSandboxConfig) =>
			applySandboxOverride(base, this.overrides.get(threadId));
	}
}
