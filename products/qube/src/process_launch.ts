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

export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
