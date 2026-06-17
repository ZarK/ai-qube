import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runQubeCli } from "../runtime.js";

export async function run(input: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runQubeCli(input);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await run();
}
