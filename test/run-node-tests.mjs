import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function collectTests(root) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      found.push(path);
    }
  }
  return found;
}

const testFiles = [...collectTests('dist'), ...collectTests('test')];
if (testFiles.length === 0) {
  console.error('No test files configured. The test command invokes the real Node.js test runner and must not pass until real tests are added.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
