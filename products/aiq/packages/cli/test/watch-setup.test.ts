import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type NodeFsModule = typeof import("node:fs");
type NodeWatch = NodeFsModule["watch"];

const watchMockState = vi.hoisted(() => ({
  actualWatch: undefined as NodeWatch | undefined,
  customWatch: undefined as NodeWatch | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<NodeFsModule>();
  watchMockState.actualWatch = actual.watch;

  return {
    ...actual,
    watch: ((...args: unknown[]) => {
      if (watchMockState.customWatch !== undefined) {
        return Reflect.apply(watchMockState.customWatch, actual, args);
      }

      return Reflect.apply(actual.watch, actual, args);
    }) as NodeWatch,
  } satisfies NodeFsModule;
});

import { runCli } from "../src/index.js";

const fixtureTsconfig = path.resolve("test-projects/typescript/tsconfig.json");
const tempDirs: string[] = [];

class MemoryOutput {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }
}

class MemoryInput {
  on(_event: string, _handler: unknown): this {
    return this;
  }

  resume(): this {
    return this;
  }

  setEncoding(_encoding?: BufferEncoding): this {
    return this;
  }
}

async function waitFor<T>(
  getValue: () => T | undefined,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = getValue();
    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function parseJsonLines<T>(value: string): T[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

async function createTypeScriptFixtureProject(
  prefix: string,
): Promise<{ filePath: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);

  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "tsconfig.json"),
    await readFile(fixtureTsconfig, "utf8"),
    "utf8",
  );

  const filePath = path.join(root, "src", "index.ts");
  await writeFile(filePath, "export const value = 1;\n", "utf8");

  return { filePath, root };
}

afterEach(async () => {
  watchMockState.customWatch = undefined;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("CLI watch setup hardening", () => {
  it("ignores ENOENT watch setup failures based on error code", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-enoent-");
    const missingWatchDir = path.join(project.root, ".qube", "aiq");

    watchMockState.customWatch = ((...args: unknown[]) => {
      const watchPath = args[0];
      const normalizedPath = watchPath instanceof URL ? watchPath.pathname : String(watchPath);
      if (normalizedPath === missingWatchDir) {
        throw Object.assign(new Error("missing watch target"), { code: "ENOENT" as const });
      }

      if (watchMockState.actualWatch === undefined) {
        throw new Error("Expected original fs.watch implementation.");
      }

      return Reflect.apply(watchMockState.actualWatch, undefined, args);
    }) as NodeWatch;

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      [
        "node",
        "aiq",
        "watch",
        "src/index.ts",
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "40",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const firstRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean; request: { context: string } };
      }>(stdout.value);
      return lines.find((line) => line.event === "run");
    });

    expect(firstRun.result.ok).toBe(true);
    expect(firstRun.result.request.context).toBe("watch");
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});
