#!/usr/bin/env node

const { readFileSync } = require('fs');
const { resolve, dirname } = require('path');

function getVersion() {
  try {
    // After compilation this file lives at dist/bin/aie.js.
    // package.json is two directories up from there.
    const pkgPath = resolve(dirname(__dirname), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(getVersion());
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('aie - AI Executor');
  console.log('');
  console.log('Usage:');
  console.log('  aie --version');
  console.log('  aie --help');
  console.log('');
  console.log('Run `aie --help` to see available commands.');
  process.exit(0);
}

console.log('aie - AI Executor');
console.log('Run `aie --help` for usage.');
process.exit(0);
