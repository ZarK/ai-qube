import os from "node:os";

export const defaultProjectConcurrencyLimitCap = 4;
export const projectConcurrencyLimitEnvVar = "AIQ_PROJECT_CONCURRENCY_LIMIT";

export function resolveProjectConcurrencyLimit(): number {
  const envValue = process.env[projectConcurrencyLimitEnvVar];
  if (envValue !== undefined && envValue.trim().length > 0) {
    return parseProjectConcurrencyLimit(envValue, projectConcurrencyLimitEnvVar);
  }

  return computeDefaultProjectConcurrencyLimit();
}

export function computeDefaultProjectConcurrencyLimit(): number {
  const availableParallelism =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(availableParallelism, defaultProjectConcurrencyLimitCap));
}

function parseProjectConcurrencyLimit(value: string, source: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${source} must be a positive integer.`);
  }

  return validateProjectConcurrencyLimit(Number(value), source);
}

function validateProjectConcurrencyLimit(value: number, source: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${source} must be a positive integer.`);
  }

  return value;
}
