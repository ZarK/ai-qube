'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, dirname, join, resolve } = require('node:path');

// Spawned CLI integration tests inherit one persistent V8 compile cache so
// repeated bin/run boots skip recompiling the dist bundle on every spawn.
const compileCacheDir = join(tmpdir(), 'aie-test-compile-cache');
mkdirSync(compileCacheDir, { recursive: true });
if (!process.env.NODE_COMPILE_CACHE) process.env.NODE_COMPILE_CACHE = compileCacheDir;

// Git for Windows resolves `git` through a cmd wrapper that spawns the real
// binary as a second process, doubling the per-call cost of a suite that runs
// thousands of real git commands. Preferring the direct binary on PATH keeps
// identical git behavior with one process per call. No-op elsewhere.
if (process.platform === 'win32' && !process.env.AIE_TEST_GIT_PATH_PREPENDED) {
  try {
    const located = execFileSync('where.exe', ['git'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      .split(/\r?\n/).map(line => line.trim()).find(line => line !== '');
    if (located && /\\cmd\\git\.exe$/i.test(located)) {
      const direct = resolve(dirname(located), '..', 'mingw64', 'bin');
      if (existsSync(join(direct, 'git.exe'))) {
        process.env.PATH = `${direct}${delimiter}${process.env.PATH ?? ''}`;
        process.env.AIE_TEST_GIT_PATH_PREPENDED = '1';
      }
    }
  } catch {
    // Without a resolvable git wrapper the PATH stays untouched.
  }
}

module.exports = { compileCacheDir };
