const TOKEN_PATTERNS: RegExp[] = [
  /\b(ghp_[A-Za-z0-9_]{10,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghs_[A-Za-z0-9_]{10,})\b/g,
  /\b(gho_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghu_[A-Za-z0-9_]{10,})\b/g,
  /\bglpat-[A-Za-z0-9_-]{10,}\b/gi,
  /\bsk-(?:[a-z0-9]+-)*[a-z0-9_-]{10,}\b/gi,
  /\bxai-[A-Za-z0-9_-]{10,}\b/gi,
  /\bnpm_[A-Za-z0-9]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const PRIVATE_KEY_PATTERN = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const LABELED_SECRET_PATTERN = /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)(\s*[:=]\s*)("[^"]{6,}"|'[^']{6,}'|[^\s,;]{6,})/gi;

export function redact(text: string): string {
  let out = text.replace(PRIVATE_KEY_PATTERN, '[REDACTED]');
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  out = out.replace(LABELED_SECRET_PATTERN, (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`);
  return out.replace(/\b([A-Za-z0-9_-]{40,})\b/g, match => {
    if (/[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match)) {
      return '[REDACTED]';
    }
    return match;
  });
}
