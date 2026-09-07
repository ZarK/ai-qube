import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type InteractiveProcessResult<T> = Readonly<{
  status: "observed" | "exited" | "error" | "timeout";
  observation?: T;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorCode?: string;
}>;

export async function runInteractiveProcess<T>(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly inspect: () => T | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
}): Promise<InteractiveProcessResult<T>> {
  const invocation = interactiveCommandInvocation(input.command, input.args);
  let child: ChildProcess;
  let spawnError: string | undefined;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd,
      env: input.environment ?? process.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["inherit", 2, 2],
      ...((input.windowsVerbatimArguments || invocation.windowsVerbatimArguments) ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    return Object.freeze({ status: "error", errorCode: nodeErrorCode(error) });
  }
  child.once("error", (error) => { spawnError = nodeErrorCode(error); });

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < input.timeoutMs) {
      const observation = input.inspect();
      if (observation !== undefined) return Object.freeze({ status: "observed", observation });
      if (spawnError) return Object.freeze({ status: "error", errorCode: spawnError });
      const completion = processCompletion(child);
      if (completion) return completion;
      await delay(50);
    }
    return Object.freeze({ status: "timeout" });
  } finally {
    await stopInteractiveProcessTree(child);
  }
}

export function cursorInteractiveTerminalReady(
  input: Pick<NodeJS.ReadStream, "isTTY"> = process.stdin,
  diagnostic: Pick<NodeJS.WriteStream, "isTTY"> = process.stderr,
): boolean {
  return input.isTTY === true && diagnostic.isTTY === true;
}

function processCompletion(child: ChildProcess): InteractiveProcessResult<never> | undefined {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Object.freeze({ status: "exited", exitCode: child.exitCode, signal: child.signalCode });
  }
  return undefined;
}

async function stopInteractiveProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, timeout: 10_000 });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGTERM"); } catch { /* The process already stopped. */ } }
  const deadline = Date.now() + 1_000;
  while (processGroupExists(child.pid) && Date.now() < deadline) await delay(25);
  if (!processGroupExists(child.pid)) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* The process already stopped. */ } }
}

function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

function interactiveCommandInvocation(executable: string, args: readonly string[]): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments: boolean } {
  const windowsShim = process.platform === "win32" && [".cmd", ".bat"].includes(executable.slice(executable.lastIndexOf(".")).toLowerCase());
  return windowsShim
    ? Object.freeze({ command: process.env.ComSpec ?? "cmd.exe", args: Object.freeze(["/d", "/s", "/c", `"${[quoteCmd(executable), ...args.map(quoteCmd)].join(" ")}"`]), windowsVerbatimArguments: true })
    : Object.freeze({ command: executable, args: Object.freeze([...args]), windowsVerbatimArguments: false });
}

function quoteCmd(value: string): string { return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }

function nodeErrorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code) : "spawn-failed";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
