import { access } from "node:fs/promises";
import path from "node:path";

import type { FileManifest, FileManifestInput } from "./contracts.js";

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
      await access(resolved);
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
  if (files.length === 0) {
    throw new Error("No input files were provided.");
  }

  return {
    entries: files.map((file) => ({
      extension: path.extname(file),
      path: file,
    })),
    files,
    root: cwd,
    source: input.source,
    summary: {
      fileCount: files.length,
    },
  };
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
