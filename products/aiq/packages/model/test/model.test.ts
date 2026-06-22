import { describe, expect, it } from "vitest";

import { languageIds, runContexts, surfaceIds } from "../src/index.js";

describe("model package", () => {
  it("uses one canonical surface list for runtime contexts", () => {
    expect(runContexts).toBe(surfaceIds);
    expect(surfaceIds).toEqual(["cli", "hook", "github", "opencode", "lsp", "watch", "serve"]);
  });

  it("captures the rewrite language ids in one place", () => {
    expect(languageIds).toEqual([
      "javascript",
      "typescript",
      "python",
      "terraform",
      "hcl",
      "go",
      "rust",
      "dotnet",
      "java",
      "kotlin",
      "bash",
      "powershell",
      "html",
      "css",
      "yaml",
      "sql",
      "documents",
    ]);
  });
});
