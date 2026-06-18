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
  it("closes the connection for declared oversized serve request bodies", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-declared-oversized-");
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
        "content-length": String(1_100_000),
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
        let responseBody = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          responseBody += chunk;
        });
        incoming.on("end", () => {
          try {
            resolve({
              headers: incoming.headers,
              payload: JSON.parse(responseBody) as { error: string },
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

    oversizedRequest.end('{"manifest":{"files":["src/index.ts"]}}');

    await expect(oversizedResponse).resolves.toMatchObject({
      headers: {
        connection: "close",
      },
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
