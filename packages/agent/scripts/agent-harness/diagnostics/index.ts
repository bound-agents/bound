/**
 * Diagnostic plugin registry.
 *
 * Each registered diagnostic is selectable via `--diagnostic <name>` on the
 * CLI. To add a new diagnostic: implement `Diagnostic` in this directory
 * and register it inside `registerBuiltinDiagnostics`.
 */

import { cacheDiagnostic } from "./cache";
import type { Diagnostic } from "./types";

const REGISTRY = new Map<string, Diagnostic>();

export function registerDiagnostic(d: Diagnostic): void {
	REGISTRY.set(d.name, d);
}

export function listDiagnostics(): ReadonlyMap<string, Diagnostic> {
	return REGISTRY;
}

export function registerBuiltinDiagnostics(): void {
	if (REGISTRY.size > 0) return; // idempotent
	registerDiagnostic(cacheDiagnostic);
}
