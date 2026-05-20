export const redactionPlaceholder = "[REDACTED]";

export interface RedactionOptions {
  readonly placeholder?: string;
  readonly sensitiveKeys?: readonly string[];
}

const directTokenPatterns = Object.freeze([
  /\b(sk-ant-api03-[A-Za-z0-9_-]{40,})\b/g,
  /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g
]);

const bearerPattern = /\b(Bearer\s+)([A-Za-z0-9._-]{20,})\b/gi;
const assignmentPattern = /\b((?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credential)\s*[:=]\s*["']?)([A-Za-z0-9_./+=-]{12,})(["']?)/gi;

const defaultSensitiveKeys = Object.freeze([
  "apiKey",
  "apikey",
  "accessToken",
  "refreshToken",
  "authorization",
  "credential",
  "password",
  "privateKey",
  "secret",
  "token"
] as const);

export function redactText(value: string, options: RedactionOptions = {}): string {
  const placeholder = options.placeholder ?? redactionPlaceholder;
  const directRedacted = directTokenPatterns.reduce((text, pattern) => text.replace(pattern, placeholder), value);
  const bearerRedacted = directRedacted.replace(bearerPattern, (_match, prefix: string) => `${prefix}${placeholder}`);
  return bearerRedacted.replace(assignmentPattern, (_match, prefix: string, _secret: string, suffix: string) => `${prefix}${placeholder}${suffix}`);
}

export function redactStructuredValue<T>(value: T, options: RedactionOptions = {}): T {
  return redactValue(value, options, undefined, new WeakMap<object, unknown>()) as T;
}

export function isSensitiveKey(key: string, sensitiveKeys: readonly string[] = defaultSensitiveKeys): boolean {
  const normalized = normalizeKey(key);
  return sensitiveKeys.some((sensitiveKey) => normalizeKey(sensitiveKey) === normalized);
}

function redactValue(value: unknown, options: RedactionOptions, key: string | undefined, seen: WeakMap<object, unknown>): unknown {
  if (key && isSensitiveKey(key, options.sensitiveKeys) && value !== undefined && value !== null) {
    return options.placeholder ?? redactionPlaceholder;
  }
  if (typeof value === "string") {
    return redactText(value, options);
  }
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(redactValue(item, options, undefined, seen));
    }
    return Object.freeze(copy);
  }
  if (isRecord(value)) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const entryKey of Object.keys(value)) {
      const entryValue = value[entryKey];
      copy[entryKey] = redactValue(entryValue, options, entryKey, seen);
    }
    return Object.freeze(copy);
  }
  return value;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
