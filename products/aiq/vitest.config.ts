import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const workspaceRoot = fileURLToPath(new URL("./", import.meta.url));
const runInCi = Boolean(process.env.CI);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@tjalve/aiq/api",
        replacement: path.resolve(workspaceRoot, "packages/cli/src/api.ts"),
      },
      {
        find: "@tjalve/aiq/schema",
        replacement: path.resolve(workspaceRoot, "packages/cli/src/schema.ts"),
      },
      {
        find: "@tjalve/aiq/benchmark",
        replacement: path.resolve(workspaceRoot, "packages/benchmark/src/index.ts"),
      },
      {
        find: "@tjalve/aiq/config",
        replacement: path.resolve(workspaceRoot, "packages/config-schema/src/index.ts"),
      },
      {
        find: "@tjalve/aiq/engine",
        replacement: path.resolve(workspaceRoot, "packages/engine/src/index.ts"),
      },
      {
        find: "@tjalve/aiq/model",
        replacement: path.resolve(workspaceRoot, "packages/model/src/index.ts"),
      },
      {
        find: "@tjalve/aiq/reporters",
        replacement: path.resolve(workspaceRoot, "packages/reporters/src/index.ts"),
      },
      {
        find: "@tjalve/aiq",
        replacement: path.resolve(workspaceRoot, "packages/cli/src/index.ts"),
      },
    ],
  },
  test: {
    fileParallelism: !runInCi,
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
