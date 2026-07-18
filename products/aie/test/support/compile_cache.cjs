'use strict';

const { mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// Spawned CLI integration tests inherit one persistent V8 compile cache so
// repeated bin/run boots skip recompiling the dist bundle on every spawn.
const compileCacheDir = join(tmpdir(), 'aie-test-compile-cache');
mkdirSync(compileCacheDir, { recursive: true });
if (!process.env.NODE_COMPILE_CACHE) process.env.NODE_COMPILE_CACHE = compileCacheDir;

module.exports = { compileCacheDir };
