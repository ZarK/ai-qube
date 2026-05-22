const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');

describe('lifecycle service architecture', () => {
  it('keeps lifecycle command workflow modules off raw GitHub helper internals', () => {
    const root = process.cwd();
    for (const relativePath of ['src/start/index.ts', 'src/switch/index.ts', 'src/complete/index.ts', 'src/view.ts']) {
      const source = readFileSync(join(root, relativePath), 'utf8');
      assert.doesNotMatch(source, /from '\.\/github'/, `${relativePath} must use work providers instead of raw GitHub helpers`);
      assert.doesNotMatch(source, /runGh|GhExecutionError|GhRunResult/, `${relativePath} must route mutations through provider action plans`);
    }
  });

  it('keeps PR command workflow modules behind review providers and app services', () => {
    const root = process.cwd();
    for (const relativePath of ['src/pr/index.ts', 'src/app/pr_gate.ts', 'src/app/pr_body.ts']) {
      const source = readFileSync(join(root, relativePath), 'utf8');
      assert.doesNotMatch(source, /from ['"].*(?:^|\/)gh['"]/, `${relativePath} must not execute gh directly`);
      assert.doesNotMatch(source, /runGh|GhExecutionError|GhRunResult/, `${relativePath} must route PR state through review providers`);
      assert.doesNotMatch(source, /reviewThreads|aie:pr-gate/, `${relativePath} must keep GitHub review-thread and marker details inside the GitHub review provider`);
    }
  });
});
