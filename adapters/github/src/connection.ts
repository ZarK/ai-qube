import {
  githubConnectionContract,
  runConnectionProbe,
  type ConnectionCommandResult,
  type ConnectionProbeOptions,
  type ConnectionProbeResult,
} from "@tjalve/qube-core";
import { execFile } from "node:child_process";

export async function probeGitHubConnection(options: ConnectionProbeOptions = {}): Promise<ConnectionProbeResult> {
  return runConnectionProbe(githubConnectionContract, {
    ...options,
    env: options.env ?? process.env,
    exec: options.exec ?? executeGh,
  });
}

function executeGh(command: string, args: readonly string[], timeoutMs: number): Promise<ConnectionCommandResult> {
  return new Promise(resolve => {
    execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      const timedOut = error !== null && (error.killed === true || error.code === "ETIMEDOUT");
      resolve({ exitCode, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}
