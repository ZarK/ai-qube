import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  [
    "./node_modules/vitest/vitest.mjs",
    "run",
    "packages/cli/test/cli.test.ts",
    "--testNamePattern=CLI package smoke",
  ],
  {
    env: {
      ...process.env,
      AIQ_SMOKE: "1",
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
