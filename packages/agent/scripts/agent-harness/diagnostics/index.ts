/**
 * Diagnostic plugin registry.
 *
 * Each registered diagnostic is selectable via `--diagnostic <name>` on the
 * CLI. To add a new diagnostic: implement `Diagnostic` in this directory
 * and register it inside `registerBuiltinDiagnostics`.
 */

import { buildCacheDiagnostic } from "./cache";
import type { Diagnostic } from "./types";

/**
 * Diagnostics carry per-instance state (e.g. the cache diagnostic tracks
 * the prior turn's wire body for byte-diff). Each entry in the registry
 * is a FACTORY rather than a singleton instance so a single process
 * running multiple harness invocations gets fresh state per run.
 */
type DiagnosticFactory = () => Diagnostic;

const REGISTRY = new Map<string, DiagnosticFactory>();

export function registerDiagnostic(name: string, factory: DiagnosticFactory): void {
	REGISTRY.set(name, factory);
}

/**
 * Returns a snapshot map of name → freshly-built diagnostic. Each call
 * builds new instances; closure state in any single instance never
 * leaks across invocations.
 */
export function listDiagnostics(): ReadonlyMap<string, Diagnostic> {
	const out = new Map<string, Diagnostic>();
	for (const [name, factory] of REGISTRY) out.set(name, factory());
	return out;
}

export function registerBuiltinDiagnostics(): void {
	if (REGISTRY.size > 0) return; // idempotent
	registerDiagnostic("cache", buildCacheDiagnostic);
}
