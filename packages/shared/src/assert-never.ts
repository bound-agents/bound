/**
 * Exhaustive switch helper. Use as the `default` case in switch statements
 * over discriminated unions to get a compile-time error when a new variant
 * is added but not handled.
 *
 * @example
 * ```ts
 * switch (entry.kind) {
 *   case "tool_call": break;
 *   case "result": break;
 *   default: assertNever(entry.kind, `Unhandled relay kind`);
 * }
 * ```
 */
export function assertNever(value: never, message?: string): never {
	throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
