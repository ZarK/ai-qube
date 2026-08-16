import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));
const distEntry = join(packageRoot, 'dist', 'bin', 'run.js');
const srcRoot = join(packageRoot, 'src');

function newestSourceTime(dir) {
  let newest = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceTime(path));
      continue;
    }
    if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

export function ensureAieDist() {
  const missing = !existsSync(distEntry);
  const stale = missing || (existsSync(srcRoot) && newestSourceTime(srcRoot) > statSync(distEntry).mtimeMs);
  if (!stale) return;
  const tsc = join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    throw new Error('AIE dist is missing or stale and typescript is not installed. Run: pnpm --dir products/aie run build');
  }
  const result = spawnSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error('AIE dist is missing or stale. Run: pnpm --dir products/aie run build');
  }
}
