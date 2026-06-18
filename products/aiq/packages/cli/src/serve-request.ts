import type { IncomingMessage, ServerResponse } from "node:http";

import { type AiqProfileName, aiqProfileNames } from "@tjalve/aiq/config";
import { type ManifestSource, type StageId, manifestSources, stageIds } from "@tjalve/aiq/model";

import { formatError } from "./shared.js";
import { maxServeRequestBodyBytes } from "./types.js";

interface ServeManifestRequest {
  files: string[];
  source?: ManifestSource;
}

export interface ServeRunRequestBody {
  manifest: ServeManifestRequest;
  outDir?: string;
  profile?: string;
  stages?: string[];
}


export class ServeRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeRequestValidationError";
  }
}

export class ServeRequestTooLargeError extends ServeRequestValidationError {
  readonly closeConnection: boolean;

  constructor(
    message = `Serve request body exceeds ${maxServeRequestBodyBytes} bytes.`,
    closeConnection = false,
  ) {
    super(message);
    this.name = "ServeRequestTooLargeError";
    this.closeConnection = closeConnection;
  }
}

export class ServeRequestCancelledError extends Error {
  constructor(message = "AIQ serve request cancelled.") {
    super(message);
    this.name = "ServeRequestCancelledError";
  }
}

export async function readJsonRequest(request: IncomingMessage, signal?: AbortSignal): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  const declaredBodyBytes = typeof contentLength === "string" ? Number(contentLength) : undefined;
  const declaredTooLarge =
    declaredBodyBytes !== undefined &&
    Number.isFinite(declaredBodyBytes) &&
    declaredBodyBytes > maxServeRequestBodyBytes;

  const body = await new Promise<string>((resolve, reject) => {
    let value = "";
    let byteLength = 0;
    let tooLarge = declaredTooLarge;
    let settled = false;
    const cleanup = (): void => {
      request.off("close", onClose);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (result: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void => {
      rejectOnce(new ServeRequestCancelledError());
    };
    const onClose = (): void => {
      if (!request.destroyed || request.complete) {
        return;
      }

      rejectOnce(new ServeRequestCancelledError());
    };
    const onData = (chunk: string): void => {
      byteLength += Buffer.byteLength(chunk, "utf8");
      if (byteLength > maxServeRequestBodyBytes) {
        tooLarge = true;
      }

      if (tooLarge) {
        rejectOnce(new ServeRequestTooLargeError(undefined, true));
        return;
      }

      value += chunk;
    };
    const onEnd = (): void => {
      if (tooLarge) {
        return;
      }

      resolveOnce(value);
    };
    const onError = (error: Error): void => {
      rejectOnce(error);
    };

    if (signal?.aborted) {
      rejectOnce(new ServeRequestCancelledError());
      return;
    }

    if (declaredTooLarge) {
      rejectOnce(new ServeRequestTooLargeError(undefined, true));
      return;
    }

    request.setEncoding("utf8");
    request.on("close", onClose);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  if (body.trim().length === 0) {
    throw new ServeRequestValidationError("Serve requests require a JSON body.");
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new ServeRequestValidationError(`Invalid JSON body: ${formatError(error)}`);
  }
}

export function parseServeRunRequestBody(value: unknown): ServeRunRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServeRequestValidationError("Serve requests must be JSON objects.");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.manifest !== "object" ||
    record.manifest === null ||
    Array.isArray(record.manifest)
  ) {
    throw new ServeRequestValidationError("Serve requests require a manifest object.");
  }

  const manifestRecord = record.manifest as Record<string, unknown>;
  if (!Array.isArray(manifestRecord.files) || manifestRecord.files.length === 0) {
    throw new ServeRequestValidationError(
      "Serve requests require manifest.files with at least one file.",
    );
  }

  const files = manifestRecord.files.map((file, index) => {
    if (typeof file !== "string" || file.trim().length === 0) {
      throw new ServeRequestValidationError(`manifest.files[${index}] must be a non-empty string.`);
    }

    return file;
  });

  const source =
    manifestRecord.source === undefined
      ? undefined
      : parseManifestSource(manifestRecord.source, "manifest.source");

  return {
    manifest: {
      files,
      ...(source === undefined ? {} : { source }),
    },
    ...(record.outDir === undefined
      ? {}
      : { outDir: parseOptionalString(record.outDir, "outDir") }),
    ...(record.stages === undefined ? {} : { stages: parseStringArray(record.stages, "stages") }),
    ...(record.profile === undefined
      ? {}
      : { profile: parseOptionalString(record.profile, "profile") }),
  };
}

function parseManifestSource(value: unknown, source: string): ManifestSource {
  if (typeof value !== "string" || !manifestSources.includes(value as ManifestSource)) {
    throw new ServeRequestValidationError(
      `${source} must be one of ${manifestSources.join(", ")}.`,
    );
  }

  return value as ManifestSource;
}

function parseOptionalString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServeRequestValidationError(`${source} must be a non-empty string.`);
  }

  return value;
}

function parseStringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new ServeRequestValidationError(`${source} must be an array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ServeRequestValidationError(`${source}[${index}] must be a non-empty string.`);
    }

    return entry;
  });
}

export function parseStageList(value: string[], source: string): StageId[] {
  return value.map((stage) => {
    if (!stageIds.includes(stage as StageId)) {
      throw new ServeRequestValidationError(`Unsupported ${source} entry '${stage}'.`);
    }

    return stage as StageId;
  });
}

export function parseProfile(value: string, source: string): AiqProfileName {
  if (!aiqProfileNames.includes(value as AiqProfileName)) {
    throw new ServeRequestValidationError(
      `${source} must be one of ${aiqProfileNames.join(", ")}.`,
    );
  }

  return value as AiqProfileName;
}

export function destroyRequestAfterResponse(request: IncomingMessage, response: ServerResponse): void {
  const destroyRequest = (): void => {
    if (!request.destroyed) {
      request.destroy();
    }
  };

  if (response.writableEnded || response.destroyed) {
    destroyRequest();
    return;
  }

  response.once("finish", destroyRequest);
}


