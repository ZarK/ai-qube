import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  type AiqProfileName,
  type LoadedAiqProgress,
  aiqProfileNames,
  loadAiqProgress,
  resolveAiqProgressStageIds,
} from "@tjalve/aiq/config";
import { resolveRunRequest, runEngine } from "@tjalve/aiq/engine";
import {
  type ManifestSource,
  type RunRequest,
  type StageId,
  manifestSources,
  stageIds,
} from "@tjalve/aiq/model";

import { writeServeListeningOutput } from "./output.js";
import { resolveCliConfig } from "./requests.js";
import {
  type ActiveSignal,
  createActiveSignal,
  formatError,
  isCliCancellation,
  waitForAbort,
} from "./shared.js";
import {
  type CliIo,
  type CliRunOptions,
  type ParsedArgs,
  maxServeRequestBodyBytes,
} from "./types.js";
import { createRunWorkflowOutput } from "./workflow.js";

interface ServeManifestRequest {
  files: string[];
  source?: ManifestSource;
}

interface ServeRunRequestBody {
  manifest: ServeManifestRequest;
  outDir?: string;
  profile?: string;
  stages?: string[];
}

interface ServeRunLock {
  active: boolean;
}

interface PreparedServeRun {
  progress?: LoadedAiqProgress;
  request: RunRequest;
}

class ServeRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeRequestValidationError";
  }
}

class ServeRequestTooLargeError extends ServeRequestValidationError {
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

class ServeRequestCancelledError extends Error {
  constructor(message = "AIQ serve request cancelled.") {
    super(message);
    this.name = "ServeRequestCancelledError";
  }
}

export async function runServeCommand(
  parsed: ParsedArgs,
  io: CliIo,
  options: CliRunOptions,
): Promise<number> {
  const activeSignal = createActiveSignal(options.signal);
  const runLock: ServeRunLock = { active: false };
  let server: Server | undefined;

  try {
    server = createServer((request, response) => {
      void handleServeRequest(request, response, parsed, io, activeSignal.signal, runLock);
    });
    const address = await listenServer(server, parsed.host, parsed.port);
    writeServeListeningOutput(io, parsed.format, parsed.host, address.port);
    await waitForAbort(activeSignal.signal);
    await closeServer(server);
    return 0;
  } catch (error) {
    if (server !== undefined) {
      await closeServer(server).catch(() => undefined);
    }

    if (isCliCancellation(error, activeSignal.signal)) {
      return 0;
    }

    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  } finally {
    activeSignal.cleanup();
  }
}

async function handleServeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  parsed: ParsedArgs,
  io: CliIo,
  signal: AbortSignal,
  runLock: ServeRunLock,
): Promise<void> {
  const requestSignal = createServeRequestSignal(request, response, signal);
  let releaseLock: (() => void) | undefined;

  try {
    if (request.method === "GET" && (request.url === "/health" || request.url === "/healthz")) {
      writeJsonResponse(response, 200, { ok: true });
      return;
    }

    if (request.method !== "POST" || request.url !== "/run") {
      writeJsonResponse(response, 404, { error: "Not found." });
      return;
    }

    releaseLock = tryAcquireServeRunLock(runLock);
    if (releaseLock === undefined) {
      writeBusyServeResponse(response);
      return;
    }

    const body = parseServeRunRequestBody(await readJsonRequest(request, requestSignal.signal));
    const preparedRun = await createServeRunRequest(body, parsed, io, requestSignal.signal);
    const result = await runEngine(preparedRun.request);
    if (!response.destroyed && !response.writableEnded) {
      writeJsonResponse(response, 200, {
        ...result,
        ...(preparedRun.progress === undefined
          ? {}
          : {
              workflow: createRunWorkflowOutput(preparedRun.progress, preparedRun.request, result),
            }),
      });
    }
  } catch (error) {
    if (isCliCancellation(error, signal)) {
      if (!response.headersSent && !response.destroyed) {
        writeJsonResponse(response, 503, { error: "AIQ serve is shutting down." });
      }
      return;
    }

    if (
      error instanceof ServeRequestCancelledError ||
      isCliCancellation(error, requestSignal.signal)
    ) {
      return;
    }

    const statusCode =
      error instanceof ServeRequestTooLargeError
        ? 413
        : error instanceof ServeRequestValidationError
          ? 400
          : 500;
    if (error instanceof ServeRequestTooLargeError && error.closeConnection) {
      response.setHeader("connection", "close");
      destroyRequestAfterResponse(request, response);
    }
    if (!response.headersSent && !response.destroyed) {
      writeJsonResponse(response, statusCode, { error: formatError(error) });
    }
  } finally {
    releaseLock?.();
    requestSignal.cleanup();
  }
}

async function createServeRunRequest(
  body: ServeRunRequestBody,
  parsed: ParsedArgs,
  io: CliIo,
  signal: AbortSignal,
): Promise<PreparedServeRun> {
  const stageOverrides =
    body.stages === undefined ? undefined : parseStageList(body.stages, "serve stages");
  const profileOverride =
    body.profile === undefined ? undefined : parseProfile(body.profile, "serve profile");
  const progress = await loadOptionalServeProgress(body, parsed, io);
  const resolvedConfig = await resolveCliConfig(parsed, io, {
    surface: "serve",
    ...(stageOverrides === undefined
      ? progress === undefined
        ? {}
        : { stageOverrides: resolveAiqProgressStageIds(progress.progress.current_stage) }
      : { stageOverrides }),
    ...(profileOverride === undefined ? {} : { profileOverride }),
  });

  const runRequest: RunRequest = {
    context: "serve",
    cwd: resolvedConfig.cwd,
    manifest: {
      files: body.manifest.files,
      source: body.manifest.source ?? "direct",
    },
    mode: "check",
    ...((body.outDir ?? parsed.outDir) ? { outDir: body.outDir ?? parsed.outDir } : {}),
    stages: resolvedConfig.stages,
    profile: resolvedConfig.profile,
    signal,
    writeArtifacts: true,
  };

  try {
    await resolveRunRequest(runRequest);
  } catch (error) {
    throw new ServeRequestValidationError(formatError(error));
  }

  return {
    ...(progress === undefined ? {} : { progress }),
    request: runRequest,
  };
}

async function loadOptionalServeProgress(
  body: ServeRunRequestBody,
  parsed: ParsedArgs,
  io: CliIo,
): Promise<LoadedAiqProgress | undefined> {
  if (
    body.stages !== undefined ||
    body.profile !== undefined ||
    parsed.stages.length > 0 ||
    parsed.profile !== undefined
  ) {
    return undefined;
  }

  const progress = await loadAiqProgress(io.cwd);
  return progress.source === "file" ? progress : undefined;
}

function tryAcquireServeRunLock(runLock: ServeRunLock): (() => void) | undefined {
  if (runLock.active) {
    return undefined;
  }

  runLock.active = true;
  return () => {
    runLock.active = false;
  };
}

function writeBusyServeResponse(response: ServerResponse): void {
  response.setHeader("retry-after", "1");
  writeJsonResponse(response, 503, { error: "AIQ serve is already processing another run." });
}

function createServeRequestSignal(
  request: IncomingMessage,
  response: ServerResponse,
  parentSignal: AbortSignal,
): ActiveSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const abortOnResponseClose = (): void => {
    if (!response.writableEnded) {
      abort();
    }
  };

  if (parentSignal.aborted) {
    abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }

  const abortOnRequestClose = (): void => {
    if (request.destroyed && !request.complete) {
      abort();
    }
  };

  request.on("close", abortOnRequestClose);
  response.on("close", abortOnResponseClose);

  return {
    cleanup() {
      parentSignal.removeEventListener("abort", abort);
      request.off("close", abortOnRequestClose);
      response.off("close", abortOnResponseClose);
    },
    signal: controller.signal,
  };
}

function writeJsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonRequest(request: IncomingMessage, signal?: AbortSignal): Promise<unknown> {
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

function destroyRequestAfterResponse(request: IncomingMessage, response: ServerResponse): void {
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

function parseServeRunRequestBody(value: unknown): ServeRunRequestBody {
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

function parseStageList(value: string[], source: string): StageId[] {
  return value.map((stage) => {
    if (!stageIds.includes(stage as StageId)) {
      throw new ServeRequestValidationError(`Unsupported ${source} entry '${stage}'.`);
    }

    return stage as StageId;
  });
}

function parseProfile(value: string, source: string): AiqProfileName {
  if (!aiqProfileNames.includes(value as AiqProfileName)) {
    throw new ServeRequestValidationError(
      `${source} must be one of ${aiqProfileNames.join(", ")}.`,
    );
  }

  return value as AiqProfileName;
}

async function listenServer(server: Server, host: string, port: number): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AIQ serve expected a TCP address.");
  }

  return address;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}
