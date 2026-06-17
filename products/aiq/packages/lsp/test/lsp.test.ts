import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../config-schema/src/index.js";
import type { RunRequest as EngineRunRequest } from "../../model/src/index.js";

import {
  AiqLspCancelledError,
  createAiqLspAdapter,
  lspDiagnosticSeverities,
  resolveDocumentUri,
} from "../src/index.js";

const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");
const lintFailureFixtureFile = path.resolve("test-projects/typescript/src/lint-failure.ts");
const fixtureTsconfig = path.resolve("test-projects/typescript/tsconfig.json");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("AIQ LSP adapter", () => {
  it("maps document diagnostics and returns unchanged when the result id matches", async () => {
    const adapter = createAiqLspAdapter({
      cwd: process.cwd(),
      documentStages: ["lint"],
      writeArtifacts: false,
    });

    const uri = resolveDocumentUri(lintFailureFixtureFile);
    const report = await adapter.getDocumentDiagnosticReport({
      textDocument: { uri, version: 7 },
    });

    expect(report.kind).toBe("full");
    if (report.kind !== "full") {
      throw new Error("Expected a full diagnostic report.");
    }

    expect(report.items[0]).toMatchObject({
      code: "lint/style/noVar",
      severity: lspDiagnosticSeverities.error,
      source: "aiq/biome",
    });
    expect(report.items[0]?.range).toEqual({
      end: {
        character: 15,
        line: 1,
      },
      start: {
        character: 2,
        line: 1,
      },
    });

    const unchanged = await adapter.getDocumentDiagnosticReport({
      previousResultId: report.resultId,
      textDocument: { uri, version: 7 },
    });

    expect(unchanged).toEqual({
      kind: "unchanged",
      resultId: report.resultId,
    });
  });

  it("maps workspace diagnostics for requested and related project files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-lsp-workspace-"));
    tempDirs.push(tempDir);

    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(
      path.join(tempDir, "tsconfig.json"),
      await readFile(fixtureTsconfig, "utf8"),
      "utf8",
    );

    const requestedFile = path.join(tempDir, "src", "requested.ts");
    await writeFile(requestedFile, await readFile(fixtureFile, "utf8"), "utf8");

    const relatedFile = path.join(tempDir, "src", "related.ts");
    await writeFile(
      relatedFile,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );

    const adapter = createAiqLspAdapter({
      cwd: tempDir,
      documentStages: ["lint"],
      workspaceStages: ["typecheck"],
      writeArtifacts: false,
    });

    const requestedUri = resolveDocumentUri(requestedFile);
    const relatedUri = resolveDocumentUri(relatedFile);

    const report = await adapter.getWorkspaceDiagnosticReport({
      textDocuments: [{ uri: requestedUri, version: 1 }],
    });

    expect(report.items).toHaveLength(2);
    expect(report.items.find((item) => item.uri === requestedUri)).toMatchObject({
      items: [],
      kind: "full",
      uri: requestedUri,
      version: 1,
    });
    expect(report.items.find((item) => item.uri === relatedUri)).toMatchObject({
      kind: "full",
      uri: relatedUri,
      version: null,
    });

    const relatedReport = report.items.find((item) => item.uri === relatedUri);
    if (relatedReport?.kind !== "full") {
      throw new Error("Expected a full workspace diagnostic report for the related file.");
    }

    expect(relatedReport.items[0]).toMatchObject({
      code: "TS2322",
      severity: lspDiagnosticSeverities.error,
      source: "aiq/tsc",
    });

    const unchanged = await adapter.getWorkspaceDiagnosticReport({
      previousResultIds: report.items.map((item) => ({
        uri: item.uri,
        value: item.resultId,
      })),
      textDocuments: [{ uri: requestedUri, version: 1 }],
    });

    expect(unchanged.items).toEqual(
      report.items.map((item) => ({
        kind: "unchanged",
        resultId: item.resultId,
        uri: item.uri,
        version: item.version,
      })),
    );
  });

  it("supports cancellation and progress reporting", async () => {
    const progressEvents: string[] = [];
    const adapter = createAiqLspAdapter({
      cwd: process.cwd(),
      documentStages: ["lint"],
      writeArtifacts: false,
    });

    const report = await adapter.getDocumentDiagnosticReport({
      onProgress: (event) => {
        progressEvents.push(`${event.kind}:${event.message}`);
      },
      textDocument: { uri: resolveDocumentUri(lintFailureFixtureFile) },
    });

    expect(report.kind).toBe("full");
    expect(progressEvents).toEqual([
      "begin:Resolving AIQ document diagnostics.",
      "report:Running AIQ document diagnostics for 1 file.",
      "report:Collected 1 diagnostic.",
      "end:AIQ document diagnostics complete.",
    ]);

    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.getDocumentDiagnosticReport({
        signal: controller.signal,
        textDocument: { uri: resolveDocumentUri(lintFailureFixtureFile) },
      }),
    ).rejects.toBeInstanceOf(AiqLspCancelledError);
  });

  it("surfaces mid-run cancellation after forwarding the abort signal to the engine", async () => {
    const controller = new AbortController();
    const progressEvents: string[] = [];
    let forwardedSignal: AbortSignal | undefined;
    let forwardedStageConfigurations: EngineRunRequest["stageConfigurations"];
    const expectedStageConfigurations = {
      lint: {
        languages: {
          typescript: {
            toolId: "biome",
          },
        },
      },
    };

    const adapter = createAiqLspAdapter({
      cwd: process.cwd(),
      documentStages: ["lint"],
      resolveConfigImpl: async () => ({
        cadenceStages: [],
        changedOnly: true,
        config: defaultConfig,
        cwd: process.cwd(),
        stages: ["lint"],
        stageConfigurations: expectedStageConfigurations,
        profile: "fast",
        publishDiagnostics: true,
        source: "defaults",
        surface: "lsp",
      }),
      runEngineImpl: async (request: EngineRunRequest) => {
        forwardedSignal = request.signal;
        forwardedStageConfigurations = request.stageConfigurations;
        return await new Promise<never>((_resolve, reject) => {
          const cancel = () => {
            reject(new Error("aborted by test signal"));
          };

          request.signal?.addEventListener("abort", cancel, { once: true });
          controller.abort();
          if (request.signal?.aborted) {
            cancel();
          }
        });
      },
      writeArtifacts: false,
    });

    const pendingReport = adapter.getDocumentDiagnosticReport({
      onProgress: (event) => {
        progressEvents.push(`${event.kind}:${event.message}`);
      },
      signal: controller.signal,
      textDocument: { uri: resolveDocumentUri(fixtureFile) },
    });

    await expect(pendingReport).rejects.toBeInstanceOf(AiqLspCancelledError);
    expect(forwardedSignal).toBe(controller.signal);
    expect(forwardedStageConfigurations).toEqual(expectedStageConfigurations);
    expect(progressEvents).toEqual([
      "begin:Resolving AIQ document diagnostics.",
      "report:Running AIQ document diagnostics for 1 file.",
      "end:AIQ document diagnostics cancelled.",
    ]);
  });

  it("respects publishDiagnostics when the LSP surface disables diagnostics", async () => {
    let engineCalled = false;
    const adapter = createAiqLspAdapter({
      cwd: process.cwd(),
      documentStages: ["lint"],
      resolveConfigImpl: async () => ({
        cadenceStages: [],
        changedOnly: true,
        config: defaultConfig,
        cwd: process.cwd(),
        stages: ["lint"],
        stageConfigurations: {
          lint: {
            languages: {
              typescript: {
                toolId: "biome",
              },
            },
          },
        },
        profile: "fast",
        publishDiagnostics: false,
        source: "defaults",
        surface: "lsp",
      }),
      runEngineImpl: async () => {
        engineCalled = true;
        throw new Error("Engine should not run when diagnostics are disabled.");
      },
      writeArtifacts: false,
    });

    const report = await adapter.getDocumentDiagnosticReport({
      textDocument: { uri: resolveDocumentUri(fixtureFile) },
    });

    expect(engineCalled).toBe(false);
    expect(report.kind).toBe("full");
    if (report.kind !== "full") {
      throw new Error("Expected a full empty report when diagnostics are disabled.");
    }

    expect(report.items).toEqual([]);
  });

  it("returns an empty workspace report when no text documents are requested", async () => {
    const adapter = createAiqLspAdapter({
      cwd: process.cwd(),
      workspaceStages: ["typecheck"],
      writeArtifacts: false,
    });

    await expect(
      adapter.getWorkspaceDiagnosticReport({
        textDocuments: [],
      }),
    ).resolves.toEqual({ items: [] });
  });
});
