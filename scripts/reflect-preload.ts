// Test-runner preload that guarantees `reflect-metadata` polyfills the *real*
// globalThis.Reflect before any tsyringe-touching module loads under `bun test`.
// Ordered first in `bunfig.toml`'s `preload` array so it runs before every test
// file and before scripts/test-preload.ts.
//
// Why this exists:
//   `reflect-metadata` mutates the existing globalThis.Reflect in place (adds
//   getMetadata/defineMetadata/etc.). tsyringe reads those methods off the same
//   object via its own lexical `Reflect`. On most platforms Reflect is extensible
//   and a bare `import "reflect-metadata"` anywhere in the module graph is enough.
//
//   Windows Bun is the exception: by the time a late `import "reflect-metadata"`
//   (buried in @bound/core -> container.ts) runs, something in the process has
//   left globalThis.Reflect non-extensible, so the polyfill throws
//   "Attempting to define property on object that is not extensible" and tsyringe
//   then throws "tsyringe requires a reflect polyfill". Replacing globalThis.Reflect
//   with an extensible clone does NOT help there — the lexical `Reflect` binding
//   consumers read does not follow a globalThis reassignment on Windows Bun. The
//   only thing that works is mutating the real Reflect in place, as early as
//   possible, before it is made non-extensible. That is what running this first does.
//
// If the polyfill still fails, the assertion below turns the opaque downstream
// tsyringe error into an actionable one that reports Reflect's actual state.

export {};

const before = (globalThis as { Reflect?: object }).Reflect;
const extensibleBefore = before ? Object.isExtensible(before) : false;
const frozenBefore = before ? Object.isFrozen(before) : false;

await import("reflect-metadata");

const after = (globalThis as { Reflect?: { getMetadata?: unknown } }).Reflect;
if (typeof after?.getMetadata !== "function") {
	const desc = Object.getOwnPropertyDescriptor(globalThis, "Reflect");
	throw new Error(
		`[reflect-preload] reflect-metadata did not attach getMetadata to globalThis.Reflect. Reflect before polyfill: extensible=${extensibleBefore} frozen=${frozenBefore}; property descriptor: configurable=${desc?.configurable} writable=${desc?.writable}. On Windows Bun the global Reflect is left non-extensible before the preload runs.`,
	);
}
