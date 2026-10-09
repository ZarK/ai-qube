import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FileManifest, FileManifestInput } from "./contracts.js";
import { isSupportedInputFile } from "./runner-file-rules.js";

export { isSupportedInputFile } from "./runner-file-rules.js";

export async function normalizeFileManifest(
  input: FileManifestInput,
  cwd = process.cwd(),
): Promise<FileManifest> {
  const unique = new Set<string>();

  for (const file of input.files) {
    const trimmed = file.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const resolved = path.resolve(cwd, trimmed);
    try {
      const info = await stat(resolved);
      if (isIgnoredInput(resolved, cwd, input.ignore)) {
        continue;
      }
      if (info.isDirectory()) {
        await collectDirectoryFiles(resolved, cwd, input.ignore, unique);
        continue;
      }
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new Error(
          `Input file not found: ${trimmed}. Check the path, run from the project root, or pass an existing file list with --files-from.`,
          { cause: error },
        );
      }

      throw new Error(`Unable to access input file: ${trimmed}. ${formatAccessError(error)}`, {
        cause: error,
      });
    }
    unique.add(resolved);
  }

  const files = [...unique].sort();

  return {
    entries: files.map((file) => ({
      extension: path.extname(file),
      path: file,
    })),
    files,
    ...(input.ignore === undefined ? {} : { ignore: [...input.ignore] }),
    root: cwd,
    source: input.source,
    summary: {
      fileCount: files.length,
    },
  };
}

export function isIgnoredInput(file: string, cwd: string, ignore: readonly string[] = []): boolean {
  const relative = path.relative(cwd, file).replace(/\\/gu, "/");
  const segments = relative.split("/");
  const candidates = segments.flatMap((_, index) => {
    const ancestor = segments.slice(0, index + 1).join("/");
    return [ancestor, `${ancestor}/`];
  });
  return ignore.some((pattern) => {
    const glob = pattern.replace(/\\/gu, "/");
    return candidates.some(
      (candidate) =>
        path.posix.matchesGlob(candidate, glob) || path.posix.matchesGlob(candidate, `**/${glob}`),
    );
  });
}

async function collectDirectoryFiles(
  directory: string,
  cwd: string,
  ignore: readonly string[] | undefined,
  files: Set<string>,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (isIgnoredInput(file, cwd, ignore)) continue;
    if (entry.isDirectory()) {
      await collectDirectoryFiles(file, cwd, ignore, files);
    } else if (entry.isFile() && isSupportedInputFile(file)) {
      files.add(file);
    }
  }
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function formatAccessError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
