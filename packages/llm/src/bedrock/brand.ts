/**
 * Brand helpers for the Bedrock validated-types module.
 *
 * A "brand" is a phantom type that attaches a compile-time tag to a value.
 * At runtime the value is unchanged; at compile time, functions that require
 * the branded type can only be called with values produced by the validator
 * that attaches the brand. This is how we enforce "the only way to build a
 * ConverseStream request is through `validateBedrockRequest`".
 *
 * The unique symbols are declared-only — they are never assigned, and never
 * exist at runtime. They only ever appear in the type system.
 */

declare const BedrockValidatedBrand: unique symbol;

/**
 * Attach a compile-time brand `B` to a base type `T`.
 *
 * Example:
 *   type NonEmptyString = Branded<string, "NonEmptyString">;
 *   const x: NonEmptyString = "hi" as NonEmptyString; // cast required
 */
export type Branded<T, B extends string> = T & {
	readonly [BedrockValidatedBrand]: B;
};

/**
 * Unbrand a type — produces the underlying base type.
 *
 * Useful in internal helpers that want to manipulate the base value before
 * re-branding, without leaking the brand through every intermediate step.
 */
export type Unbranded<T> = T extends Branded<infer U, string> ? U : T;
