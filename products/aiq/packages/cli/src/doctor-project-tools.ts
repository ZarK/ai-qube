import { resolveJavaScriptHostCommands } from "@tjalve/aiq/engine";
import type { StageId } from "@tjalve/aiq/model";

import type { DoctorPrerequisite } from "./doctor-tools.js";
import { defaultProjectScopeIgnoredDirectoryNames } from "./project-scope.js";

export async function resolveDoctorProjectTools(
  cwd: string,
  stages: readonly StageId[],
): Promise<DoctorPrerequisite[]> {
  const commands = await resolveJavaScriptHostCommands(
    cwd,
    stages,
    defaultProjectScopeIgnoredDirectoryNames,
  );
  return commands.map((command) => ({
    binaries: [command.command],
    install: command.install,
    name: command.name,
    required: true,
    source: command.source,
  }));
}
