/**
 * Credential scrubbing, kept free of any `vscode` import.
 *
 * It sits on two hot paths — the session log written to disk, and every event
 * the agent system emits — so it must be callable from plain Node for tests and
 * from the event bus without dragging the extension host in.
 */

const SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // KEY=value / "apiKey": "value" style assignments
  {
    re: /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|CONNECTION_?STRING)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{4,})["']?/gi,
    replace: '$1=<REDACTED>'
  },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replace: 'Bearer <REDACTED>' },
  // Azure OpenAI keys are 32+ hex chars
  { re: /\b[a-f0-9]{32,}\b/gi, replace: '<REDACTED>' },
  // JWTs
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: '<REDACTED>'
  },
  // URLs carrying credentials
  { re: /\b([a-z]+:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replace: '$1<REDACTED>@' },
  // Connection strings
  {
    re: /\b(AccountKey|SharedAccessSignature|sig)=[^;\s&]+/gi,
    replace: '$1=<REDACTED>'
  },
  // Private key blocks
  {
    re: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replace: '<REDACTED PRIVATE KEY>'
  }
];

/**
 * Strips anything that looks like a credential before it is written to disk.
 * Deliberately over-eager: a redacted note is recoverable, a leaked key is not.
 */
export function redact(text: string): string {
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
