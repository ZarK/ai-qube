import { installPreCommitHook } from "./hook-install.js";
import { runAiqHook } from "./hook.js";
import { formatRunResultOutput } from "./output.js";
import { formatError } from "./shared.js";
import type { CliIo, ParsedArgs } from "./types.js";

export async function runHookCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  try {
    if (parsed.setupSubcommand === "install") {
      if (io.entryPoint === undefined)
        throw new Error("The Quality CLI entry point is unavailable.");
      const hookPath = await installPreCommitHook(io.cwd, io.entryPoint);
      io.stdout.write(
        parsed.format === "json"
          ? `${JSON.stringify({ ok: true, hookPath })}\n`
          : `Installed pre-commit hook: ${hookPath}\n`,
      );
      return 0;
    }
    const run = await runAiqHook({ cwd: io.cwd });
    if (run.result === undefined) {
      io.stdout.write(
        parsed.format === "json"
          ? `${JSON.stringify(run)}\n`
          : "Quality hook skipped: no staged files selected.\n",
      );
      return run.exitCode;
    }
    io.stdout.write(
      formatRunResultOutput(parsed.format, run.result, "run", {
        verbose: parsed.verbose,
        color: io.stdout.isTTY === true,
        targets: run.stagedFiles,
      }),
    );
    return run.exitCode;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}
