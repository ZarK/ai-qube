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
  it("releases the serve lock as soon as a streamed request exceeds the body limit", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-streaming-oversized-");
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

    const oversizedRequest = httpRequest(`${listening.url}/run`, {
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    const oversizedResponse = new Promise<
      { kind: "response"; payload: { error: string }; statusCode: number } | { kind: "early-close" }
    >((resolve, reject) => {
      oversizedRequest.on("response", (incoming) => {
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({
              kind: "response",
              payload: JSON.parse(responseBody) as { error: string },
              statusCode: incoming.statusCode ?? 0,
            });
          } catch (error) {
            reject(error);
          }
        });
        incoming.on("error", reject);
      });
      oversizedRequest.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || error.code === "ECONNRESET") {
          resolve({ kind: "early-close" });
          return;
        }
        reject(error);
      });
    });

    oversizedRequest.write('{"manifest":{"files":["src/index.ts"]},"padding":"');
    oversizedRequest.write("x".repeat(1_100_000));

    const oversizedResult = await oversizedResponse;
    if (oversizedResult.kind === "response") {
      expect(oversizedResult).toEqual({
        kind: "response",
        payload: {
          error: "Serve request body exceeds 1048576 bytes.",
        },
        statusCode: 413,
      });
    }

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

    oversizedRequest.destroy();
    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});
