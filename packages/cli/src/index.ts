import {
  stderr as defaultStderr,
  stdin as defaultStdin,
  stdout as defaultStdout,
} from "node:process";

import { parseArgs } from "./args.js";
import {
  runBenchCommand,
  runCheckCommand,
  runConfigCommand,
  runDoctorCommand,
  runFirstRunCommand,
  runPlanCommand,
  runSetupGuidanceCommand,
  runStatusCommand,
} from "./commands.js";
import { runServeCommand } from "./serve.js";
import { formatError } from "./shared.js";
import { type CliIo, type CliRunOptions, type ParsedArgs, cliHelp } from "./types.js";
import { runWatchCommand } from "./watch.js";

export * from "./api.js";
export { cliHelp, type CliInput, type CliIo, type CliRunOptions } from "./types.js";

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo(),
  options: CliRunOptions = {},
): Promise<number> {
  let parsed: ParsedArgs;

  try {
    parsed = parseArgs(argv, io.cwd);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    io.stderr.write(cliHelp);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(cliHelp);
    return 0;
  }

  switch (parsed.command) {
    case "watch":
      return runWatchCommand(parsed, io, options);
    case "serve":
      return runServeCommand(parsed, io, options);
    case "bench":
      return runBenchCommand(parsed, io);
    case "config":
      return runConfigCommand(parsed, io);
    case "doctor":
      return runDoctorCommand(parsed, io);
    case "status":
      return runStatusCommand(parsed, io);
    case "first-run":
      return runFirstRunCommand(parsed, io);
    case "ci":
    case "hook":
    case "ignore":
    case "install-tools":
      return runSetupGuidanceCommand(parsed, io);
    case "plan":
      return runPlanCommand(parsed, io);
    case "run":
    case "check":
      return runCheckCommand(parsed, io);
  }
}

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    stderr: defaultStderr,
    stdin: defaultStdin,
    stdout: defaultStdout,
  };
}
