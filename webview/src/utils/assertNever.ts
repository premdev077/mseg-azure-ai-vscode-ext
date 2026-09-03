/**
 * Exhaustiveness guard.
 *
 * Calling this in a `default:` branch turns "we forgot to handle a new variant"
 * from a silent no-op into a compile error at every switch over that union —
 * which is the whole reason the event map is a discriminated union.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}
