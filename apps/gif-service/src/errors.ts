/**
 * A compile failure carrying a user-facing detail message. Routes map this to
 * HTTP 400 (the source is at fault), as opposed to a 500 for service faults.
 */
export class CompileError extends Error {}
