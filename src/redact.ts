/**
 * Basic secret redaction for logs and error output (M1.5).
 * Replaces token-like values (ghp_, gho_, sk-*, etc.) with [REDACTED].
 * Used by future logging and error paths.
 */

const PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub personal
  /gho_[A-Za-z0-9]{20,}/g, // GitHub OAuth
  /ghs_[A-Za-z0-9]{20,}/g, // GitHub server
  /sk-[A-Za-z0-9]{20,}/g,  // OpenAI-style
  /[A-Za-z0-9]{40,}/g,     // generic long token (last resort, conservative)
];

export function redact(input: string): string {
  let out = input;
  for (const re of PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}
