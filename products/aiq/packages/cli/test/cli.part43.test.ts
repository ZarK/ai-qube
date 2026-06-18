import { describe, expect, it } from "vitest";
import type { IncomingHttpHeaders } from "./cli-test-support.js";
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
  it("rejects oversized serve request bodies with a 413 response", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-oversized-");
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

    const oversizedResponse = new Promise<{
      headers: IncomingHttpHeaders;
      payload: { error: string };
      statusCode: number;
    }>((resolve, reject) => {
      oversizedRequest.on("response", (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({
              headers: incoming.headers,
              payload: JSON.parse(body) as { error: string },
              statusCode: incoming.statusCode ?? 0,
            });
          } catch (error) {
            reject(error);
          }
        });
        incoming.on("error", reject);
      });
      oversizedRequest.on("error", reject);
    });

    oversizedRequest.write('{"manifest":{"files":["src/index.ts"]},"padding":"');
    oversizedRequest.write("x".repeat(1_100_000));
    oversizedRequest.end('"}');

    await expect(oversizedResponse).resolves.toMatchObject({
      payload: {
        error: "Serve request body exceeds 1048576 bytes.",
      },
      statusCode: 413,
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});
