/**
 * M1.1 Baseline package tests.
 * These tests validate the package shape, engine requirement, and absence of
 * lifecycle scripts as required by the acceptance criteria.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const pkgPath = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

test('package has correct name', () => {
  assert.equal(pkg.name, '@tjalve/aie')
})

test('package exposes aie executable', () => {
  assert.ok(pkg.bin)
  assert.equal(pkg.bin.aie, './bin/run')
})

test('package requires Node.js 24 or newer', () => {
  assert.ok(pkg.engines)
  assert.ok(pkg.engines.node)
  // Accept both ">=24" and ">=24.0.0" style
  assert.match(pkg.engines.node, /^>=24/)
})

test('package has no install lifecycle scripts', () => {
  const lifecycle = ['preinstall', 'install', 'postinstall', 'prepublishOnly']
  for (const key of lifecycle) {
    assert.equal(pkg.scripts?.[key], undefined, `unexpected lifecycle script: ${key}`)
  }
})

test('package files list includes only intended artifacts', () => {
  assert.ok(Array.isArray(pkg.files))
  const allowed = new Set(['bin/', 'lib/', 'README.md'])
  for (const entry of pkg.files) {
    assert.ok(allowed.has(entry), `unexpected files entry: ${entry}`)
  }
})

test('package main and types point to compiled output', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/index.d.ts')
})

test('build output exists after compile', () => {
  const libIndex = path.join(__dirname, '..', 'lib', 'index.js')
  const libDts = path.join(__dirname, '..', 'lib', 'index.d.ts')
  assert.ok(fs.existsSync(libIndex), 'lib/index.js must exist after build')
  assert.ok(fs.existsSync(libDts), 'lib/index.d.ts must exist after build')
})

test('bin/run and bin/dev are present and executable', () => {
  const run = path.join(__dirname, '..', 'bin', 'run')
  const dev = path.join(__dirname, '..', 'bin', 'dev')
  assert.ok(fs.existsSync(run), 'bin/run must exist')
  assert.ok(fs.existsSync(dev), 'bin/dev must exist')
  // Check executable bit on Unix
  const runStat = fs.statSync(run)
  assert.ok(runStat.mode & 0o111, 'bin/run must be executable')
})
