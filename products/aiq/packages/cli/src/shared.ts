import { AiqEngineCancelledError } from "@tjalve/aiq/engine";

import type { CliInput } from "./types.js";

export interface ActiveSignal {
  cleanup(): void;
  signal: AbortSignal;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function readStdin(stdin: CliInput): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string | Buffer) => {
      value += chunk;
    });
    stdin.on("end", () => {
      resolve(value);
    });
    stdin.on("error", (error: Error) => {
      reject(error);
    });
    stdin.resume();
  });
}

export function isCliCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    error instanceof AiqEngineCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function createActiveSignal(signal?: AbortSignal): ActiveSignal {
  if (signal !== undefined) {
    return {
      cleanup() {},
      signal,
    };
  }

  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  return {
    cleanup() {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
    signal: controller.signal,
  };
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

export function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
