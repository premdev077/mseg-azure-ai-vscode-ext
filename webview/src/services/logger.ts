/**
 * One logging path.
 *
 * Scattered `console.log` cannot be levelled, filtered or forwarded, and it is
 * how secrets end up in a shared screenshot. Everything here is structured
 * context rather than concatenated strings so a future forwarder can ship it
 * to the extension's output channel without re-parsing.
 *
 * Never log tokens, prompts, file contents or repository data. The webview
 * should not hold any of those, and logging is not the place to find out.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Vite replaces this at build time; production ships without debug output.
const threshold: LogLevel = import.meta.env.DEV ? 'debug' : 'info';

function write(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): void {
  if (ORDER[level] < ORDER[threshold]) {
    return;
  }
  const line = `[azure-ai] ${message}`;
  if (level === 'error') {
    console.error(line, context ?? '');
  } else if (level === 'warn') {
    console.warn(line, context ?? '');
  } else {
    console.info(line, context ?? '');
  }
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) =>
    write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) =>
    write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) =>
    write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) =>
    write('error', message, context)
};

/**
 * Logs a message once per key.
 *
 * Used for stream-level problems — an unknown event type arrives on every
 * event of that type, and a log line per occurrence buries everything else.
 */
const announced = new Set<string>();
export function logOnce(
  key: string,
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): void {
  if (announced.has(key)) {
    return;
  }
  announced.add(key);
  write(level, message, context);
}
