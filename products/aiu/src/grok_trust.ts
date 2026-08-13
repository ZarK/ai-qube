import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GrokFolderTrustInspection {
  readonly trustFile: string;
  readonly trusted: boolean;
}

export function grokHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GROK_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".grok");
}

export function inspectGrokFolderTrust(repoRoot: string, env: NodeJS.ProcessEnv = process.env): GrokFolderTrustInspection {
  const trustFile = path.join(grokHomeDir(env), "trusted_folders.toml");
  if (!existsSync(trustFile)) {
    return { trustFile, trusted: false };
  }
  let text: string;
  try {
    text = readFileSync(trustFile, "utf8");
  } catch {
    return { trustFile, trusted: false };
  }
  const folders = parseTrustedFolders(text);
  const repo = normalizeFolderPath(repoRoot);
  const trusted = folders.some((folder) => folder.trusted && isSameOrChildFolder(repo, normalizeFolderPath(folder.path)));
  return { trustFile, trusted };
}

function parseTrustedFolders(text: string): readonly { readonly path: string; readonly trusted: boolean }[] {
  const folders: Array<{ path: string; trusted: boolean }> = [];
  const section = /\[folders\.(?:'([^']+)'|"([^"]+)")\]/g;
  let match: RegExpExecArray | null;
  while ((match = section.exec(text)) !== null) {
    const folderPath = match[1] ?? match[2] ?? "";
    const rest = text.slice(match.index + match[0].length);
    const nextSection = rest.search(/\n\[/);
    const body = nextSection === -1 ? rest : rest.slice(0, nextSection);
    folders.push({
      path: folderPath,
      trusted: /^\s*trusted\s*=\s*true\s*$/im.test(body),
    });
  }
  return folders;
}

function isSameOrChildFolder(repo: string, trustedFolder: string): boolean {
  if (repo === trustedFolder) {
    return true;
  }
  const prefix = trustedFolder.endsWith(path.sep) ? trustedFolder : `${trustedFolder}${path.sep}`;
  return repo.startsWith(prefix);
}

function normalizeFolderPath(value: string): string {
  const resolved = path.resolve(value);
  if (process.platform === "win32" && /^[A-Za-z]:/.test(resolved)) {
    return resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}
