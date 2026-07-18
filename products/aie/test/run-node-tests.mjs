import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join } from 'node:path';

// The fast path skips the subprocess-heavy integration suites (real git and
// CLI spawning) for the routine edit-test loop; `pnpm run test` always runs
// everything and remains the required verification gate.
const SLOW_INTEGRATION_TESTS = new Set([
  'branch.test.cjs',
  'doctor.test.cjs',
  'init.test.cjs',
  'lifecycle.test.cjs',
  'migrate.test.cjs',
  'pr_gate_a.test.cjs',
  'pr_gate_b.test.cjs',
  'pr_gate_c.test.cjs',
  'pr_meta.test.cjs',
  'pr_triage.test.cjs',
  'release-readiness.test.cjs',
  'repo.test.cjs',
  'review.test.cjs',
  'start.test.cjs',
  'switch.test.cjs',
  'view.test.cjs',
]);

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
    } else if (entry.isFile() && (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.cjs'))) {
      found.push(path);
    }
  }
  return found;
}

const fastOnly = process.argv.includes('--fast');
const testFiles = [...collectTests('dist'), ...collectTests('test')]
  .filter(path => !fastOnly || !SLOW_INTEGRATION_TESTS.has(basename(path)));
if (testFiles.length === 0) {
  console.error('No test files configured. The test command invokes the real Node.js test runner and must not pass until real tests are added.');
  process.exit(1);
}

// Test processes multiply their internal concurrency by the runner's file
// concurrency; an unbounded product oversubscribes subprocess spawning until
// in-test git calls exceed their own timeouts. Eight files at a time keeps the
// spawn pressure below that cliff while staying fully parallel.
const fileConcurrency = Math.min(8, Math.max(2, availableParallelism() - 1));
const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${fileConcurrency}`, ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
