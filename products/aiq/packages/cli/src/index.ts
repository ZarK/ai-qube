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
  runEvidenceCommand,
  runFirstRunCommand,
  runPlanCommand,
  runSchemaCommand,
  runSetupCommand,
  runSetupGuidanceCommand,
  runStatusCommand,
} from "./commands.js";
import { runServeCommand } from "./serve.js";
import { formatError } from "./shared.js";
import { type CliIo, type CliRunOptions, type ParsedArgs, cliHelp } from "./types.js";
import { aiqPackageName, aiqPackageVersion } from "./version.js";
import { runWatchCommand } from "./watch.js";

export * from "./api.js";
export * from "./schema.js";
export { cliHelp, type CliInput, type CliIo, type CliRunOptions } from "./types.js";

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo(),
  options: CliRunOptions = {},
): Promise<number> {
  const versionRequest = normalizeVersionRequest(argv);
  if (versionRequest !== undefined) {
    io.stdout.write(renderVersionOutput(versionRequest.json));
    return 0;
  }

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
    case "evidence":
      return runEvidenceCommand(parsed, io);
    case "status":
      return runStatusCommand(parsed, io);
    case "schema":
      return runSchemaCommand(parsed, io);
    case "setup":
      return runSetupCommand(parsed, io);
    case "first-run":
      return runFirstRunCommand(parsed, io);
    case "ci":
    case "hook":
    case "ignore":
      return runSetupGuidanceCommand(parsed, io);
    case "plan":
      return runPlanCommand(parsed, io);
    case "run":
    case "check":
      return runCheckCommand(parsed, io);
  }
}

function normalizeVersionRequest(argv: readonly string[]): { readonly json: boolean } | undefined {
  const args = argv.slice(2);
  while (args[0] === "--") {
    args.shift();
  }

  if (!args.includes("--version")) {
    return undefined;
  }

  if (!args.every((argument) => argument === "--version" || argument === "--json")) {
    return undefined;
  }

  return { json: args.includes("--json") };
}

function renderVersionOutput(json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      ok: true,
      command: "version",
      package: { name: aiqPackageName, version: aiqPackageVersion },
      version: aiqPackageVersion,
    })}\n`;
  }

  return `${aiqPackageVersion}\n`;
}

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    stderr: defaultStderr,
    stdin: defaultStdin,
    stdout: defaultStdout,
  };
}
