/**
 * Bounds on anything the event stream can grow without limit.
 *
 * A multi-agent run emits thousands of events; every one of these caps exists
 * because the unbounded version was a DOM or memory leak waiting for a long
 * session to find it.
 */

/** Tool calls retained in the store. */
export const MAX_TOOL_HISTORY = 200;

/** Tool rows rendered at once; the rest are summarised. */
export const MAX_TOOL_ROWS = 40;

/** Notices kept before the oldest is dropped. */
export const MAX_NOTICES = 6;

/** Chat messages retained. A long conversation trims from the top. */
export const MAX_MESSAGES = 200;

/** Event ids remembered for duplicate detection. */
export const MAX_SEEN_EVENTS = 5000;
