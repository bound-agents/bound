/**
 * Fixture registry. Add new fixtures by importing + registering them
 * inside `registerBuiltinFixtures`.
 */

import { autonomousTaskFixture } from "./autonomous-task";
import { longThreadFixture } from "./long-thread";
import { productionShapeFixture } from "./production-shape";
import type { HarnessFixture } from "./types";

const REGISTRY = new Map<string, HarnessFixture>();

export function registerFixture(f: HarnessFixture): void {
	REGISTRY.set(f.name, f);
}

export function listFixtures(): ReadonlyMap<string, HarnessFixture> {
	return REGISTRY;
}

export function registerBuiltinFixtures(): void {
	if (REGISTRY.size > 0) return; // idempotent
	registerFixture(autonomousTaskFixture);
	registerFixture(productionShapeFixture);
	registerFixture(longThreadFixture);
}
