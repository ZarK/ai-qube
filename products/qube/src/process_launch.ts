export interface ShellCommandPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

export function buildShellCommandPlan(command: string, platform: NodeJS.Platform = process.platform): ShellCommandPlan {
  if (command.trim() === "") throw new Error("Shell command must not be empty.");
  return platform === "win32"
    ? { executable: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true }
    : { executable: "/bin/sh", args: ["-c", command], windowsVerbatimArguments: false };
}
