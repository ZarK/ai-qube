import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runInteractiveProcess } from "../dist/src/interactive_process.js";

describe("interactive verification processes", () => {
  it("reports a real premature process exit without a completed observation", async () => {
    const result = await runInteractiveProcess({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      inspect: () => undefined,
    });
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 7);
    assert.equal(result.observation, undefined);
  });

  for (const expected of ["observed", "timeout"] as const) {
    it(`stops the launched process and its descendant after ${expected}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "aiu-interactive-"));
      const program = path.join(root, "process.cjs");
      const pidsPath = path.join(root, "pids.json");
      let pids: number[] = [];
      try {
        await writeFile(program, [
          "const fs = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore', windowsHide: true });",
          "child.once('spawn', () => fs.writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid])));",
          "setInterval(() => {}, 1000);",
        ].join("\n"), "utf8");
        const startedAt = Date.now();
        const result = await runInteractiveProcess({
          command: process.execPath,
          args: [program, pidsPath],
          cwd: root,
          timeoutMs: expected === "timeout" ? 1_500 : 5_000,
          inspect: () => expected === "observed" && existsSync(pidsPath) ? "completed" : undefined,
        });
        assert.equal(result.status, expected);
        assert.ok(Date.now() - startedAt < 15_000, "Process cleanup must be bounded.");
        pids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
        assert.equal(pids.length, 2);
        const exitDeadline = Date.now() + 1_000;
        while (pids.some(processExists) && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 25));
        for (const pid of pids) assert.equal(processExists(pid), false, `Owned process ${pid} must stop.`);
      } finally {
        if (pids.length === 0 && existsSync(pidsPath)) pids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
        for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* The owned process already stopped. */ } }
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
