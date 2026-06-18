import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  httpRequest,
  parseJsonLines,
  runCli,
  waitFor,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("rejects concurrent serve requests and releases the lock on client abort", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-lock-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const blockingRequest = httpRequest(`${listening.url}/run`, {
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    blockingRequest.on("error", () => undefined);
    blockingRequest.write('{"manifest":{"files":["src/index.ts"]},"stages":["typecheck"]');

    const busyResponse = await waitFor(async () => {
      const response = await fetch(`${listening.url}/run`, {
        body: JSON.stringify({
          manifest: {
            files: ["src/index.ts"],
          },
          stages: ["typecheck"],
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      return response.status === 503 ? response : undefined;
    });

    expect(busyResponse.status).toBe(503);
    await expect(busyResponse.json()).resolves.toEqual({
      error: "AIQ serve is already processing another run.",
    });

    blockingRequest.destroy();

    const recoveredResponse = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({
        manifest: {
          files: ["src/index.ts"],
        },
        stages: ["typecheck"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(recoveredResponse.status).toBe(200);
    await expect(recoveredResponse.json()).resolves.toMatchObject({
      context: "serve",
      request: {
        context: "serve",
      },
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("rejects invalid serve requests with a 400 response", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-invalid-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const response = await fetch(`${listening.url}/run`, {
      body: JSON.stringify({ manifest: { files: [""] } }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "manifest.files[0] must be a non-empty string.",
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});
