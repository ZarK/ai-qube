import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runAibCli } from "../runtime.js";

export async function run(input: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runAibCli(input);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await run();
}
