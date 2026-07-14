// Bun on Windows ships a non-extensible global Reflect object. reflect-metadata
// needs to attach metadata helpers to it, so we swap in an extensible wrapper
// that copies the native methods before the polyfill runs.
const nativeReflect = globalThis.Reflect;
const extensibleReflect: typeof Reflect = Object.create(Object.getPrototypeOf(nativeReflect));

for (const key of Reflect.ownKeys(nativeReflect)) {
	const descriptor = Object.getOwnPropertyDescriptor(nativeReflect, key);
	if (descriptor) {
		Object.defineProperty(extensibleReflect, key, descriptor);
	}
}

if (!Reflect.defineProperty(globalThis, "Reflect", { value: extensibleReflect })) {
	throw new Error(
		"Unable to replace the global Reflect object; reflect-metadata cannot load on this runtime.",
	);
}
