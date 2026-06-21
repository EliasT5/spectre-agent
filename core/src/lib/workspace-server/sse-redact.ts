/**
 * SSE secret redaction utilities (BRD-04 §8).
 *
 * Redacts patterns matching:
 *  - GitHub tokens  (ghp_*, ghs_*, gh_*, ghr_*)
 *  - OpenAI API keys (sk-*)
 *  - AWS access key IDs (AKIA*)
 *  - Bearer tokens
 *  - Generic high-entropy env-like assignments (KEY=<32+ char value>)
 *
 * Also caps line length to prevent log amplification.
 */

const MAX_LINE_LENGTH = 4096;

/** [pattern, replacement label] pairs applied in order. */
const REDACT_RULES: Array<[RegExp, string]> = [
  // GitHub PATs / app tokens / refresh tokens
  [/ghp_[A-Za-z0-9]{36,}/g,     '[GH_TOKEN]'],
  [/ghs_[A-Za-z0-9]{36,}/g,     '[GH_TOKEN]'],
  [/ghr_[A-Za-z0-9]{36,}/g,     '[GH_TOKEN]'],
  [/gh_[A-Za-z0-9]{36,}/g,      '[GH_TOKEN]'],
  // OpenAI / Anthropic style keys
  [/sk-[A-Za-z0-9\-_]{40,}/g,   '[SK_KEY]'],
  // AWS access key IDs
  [/AKIA[A-Z2-7]{16}/g,         '[AWS_KEY]'],
  // Bearer tokens (any scheme)
  [/Bearer\s+[A-Za-z0-9._\-/+]{20,}/gi, 'Bearer [TOKEN]'],
  // Generic env assignments with high-entropy values (KEY=<value>)
  // Only redact the value portion (>=32 chars, no spaces).
  [/(\b[A-Z][A-Z0-9_]{2,}\s*=\s*)([^\s'"]{32,})/g, '$1[REDACTED]'],
];

/**
 * Apply all redaction rules to a single line and cap its length.
 * Called per-line by createRedactingTransform() and formatSSEEvent().
 */
export function redactLine(line: string): string {
  let out = line;
  for (const [pattern, replacement] of REDACT_RULES) {
    // Reset lastIndex for global regexes (they're reused across calls).
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_LINE_LENGTH) {
    out = out.slice(0, MAX_LINE_LENGTH) + ' …[TRUNCATED]';
  }
  return out;
}

/**
 * Serialises an SSE event frame, redacting secrets from the data payload.
 *
 * @param event Named event type string.
 * @param data  Arbitrary JSON-serialisable payload.
 * @returns     Complete SSE frame ready to write to the response stream.
 */
export function formatSSEEvent(event: string, data: unknown): string {
  const raw = JSON.stringify(data);
  const safe = redactLine(raw);
  return `event: ${event}\ndata: ${safe}\n\n`;
}

// Note: the deliverable shipped Express SSE helpers here. Jerome runs
// Next.js App Router, so we drop them — SSE in Next.js uses
// ReadableStream / NextResponse and we'll wire that in the run-tests +
// shell routes when those land.
