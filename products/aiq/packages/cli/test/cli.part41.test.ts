import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  parseJsonLines,
  runCli,
  waitFor,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("serves run requests with structured JSON and shuts down cleanly", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-");
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

    const healthResponse = await fetch(`${listening.url}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({ ok: true });

    const runResponse = await fetch(`${listening.url}/run`, {
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

    expect(runResponse.status).toBe(200);
    await expect(runResponse.json()).resolves.toMatchObject({
      context: "serve",
      ok: true,
      request: {
        context: "serve",
      },
      summary: {
        status: "passed",
      },
    });
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});
