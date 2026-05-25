import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const workspaceRoot = fileURLToPath(new URL("./", import.meta.url));
const runInCi = Boolean(process.env.CI);

export default defineConfig({
  resolve: {
    alias: {
      "@tjalve/aiq/api": path.resolve(workspaceRoot, "packages/cli/src/api.ts"),
      "@tjalve/aiq": path.resolve(workspaceRoot, "packages/cli/src/index.ts"),
      "@tjalve/aiq-benchmark": path.resolve(workspaceRoot, "packages/benchmark/src/index.ts"),
      "@tjalve/aiq-config-schema": path.resolve(
        workspaceRoot,
        "packages/config-schema/src/index.ts",
      ),
      "@tjalve/aiq-model": path.resolve(workspaceRoot, "packages/model/src/index.ts"),
      "@tjalve/aiq-action": path.resolve(workspaceRoot, "packages/github-action/src/index.ts"),
      "@tjalve/aiq-engine": path.resolve(workspaceRoot, "packages/engine/src/index.ts"),
      "@tjalve/aiq-hook": path.resolve(workspaceRoot, "packages/hook/src/index.ts"),
      "@tjalve/aiq-lsp": path.resolve(workspaceRoot, "packages/lsp/src/index.ts"),
      "@tjalve/aiq-mcp": path.resolve(workspaceRoot, "packages/mcp/src/index.ts"),
      "@tjalve/aiq-opencode": path.resolve(workspaceRoot, "packages/opencode-plugin/src/index.ts"),
      "@tjalve/aiq-reporters": path.resolve(workspaceRoot, "packages/reporters/src/index.ts"),
    },
  },
  test: {
    fileParallelism: !runInCi,
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
