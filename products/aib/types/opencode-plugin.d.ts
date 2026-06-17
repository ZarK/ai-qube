declare module "@opencode-ai/plugin" {
  export type Plugin = (context: { worktree: string }) => Promise<{
    event?: (args: {
      event: {
        type: string;
        properties: {
          todos?: unknown;
          sessionID: string;
        };
      };
    }) => Promise<void>;
    "experimental.session.compacting"?: (
      input: { sessionID: string },
      output: { context: string[] },
    ) => Promise<void>;
  }>;
}

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
}

declare module "node:path" {
  const path: {
    dirname(pathname: string): string;
    join(...parts: string[]): string;
  };

  export default path;
}
