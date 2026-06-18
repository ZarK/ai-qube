import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  type LoadedAiqProgress,
  loadAiqProgress,
  resolveAiqProgressStageIds,
} from "@tjalve/aiq/config";
import { resolveRunRequest, runEngine } from "@tjalve/aiq/engine";
import {
  type RunRequest,
  type StageId,
} from "@tjalve/aiq/model";

import { writeServeListeningOutput } from "./output.js";
import {
  ServeRequestCancelledError,
  ServeRequestTooLargeError,
  ServeRequestValidationError,
  type ServeRunRequestBody,
  destroyRequestAfterResponse,
  parseProfile,
  parseServeRunRequestBody,
  readJsonRequest,
  parseStageList,
} from "./serve-request.js";
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

interface ServeRunLock {
  active: boolean;
}

interface PreparedServeRun {
  progress?: LoadedAiqProgress;
  request: RunRequest;
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
