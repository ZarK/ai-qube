'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  defaultInstructionContextSources,
  registeredInstructionPaths,
} = require('../dist/agent_host_adapters.js');
const { getDefaults } = require('../dist/config/defaults.js');

describe('instruction context sources from host targets', () => {
  it('includes CLAUDE.md in default review context sources', () => {
    const defaults = getDefaults().reviewContextSources.instructions;
    assert.ok(defaults.includes('CLAUDE.md'));
    assert.ok(defaults.includes('**/CLAUDE.md'));
    assert.ok(defaults.includes('AGENTS.md'));
    assert.ok(defaults.includes('**/AGENTS.md'));
  });

  it('locks default instruction sources to the host adapter registry', () => {
    assert.deepEqual(getDefaults().reviewContextSources.instructions, defaultInstructionContextSources());
    const registered = registeredInstructionPaths();
    assert.ok(registered.includes('CLAUDE.md'));
    assert.ok(registered.includes('AGENTS.md'));
    for (const path of registered) {
      const filename = path.split('/').pop();
      assert.ok(getDefaults().reviewContextSources.instructions.includes(filename), `${filename} missing from defaults`);
      assert.ok(getDefaults().reviewContextSources.instructions.includes(`**/${filename}`), `**/${filename} missing from defaults`);
    }
  });

  it('does not add an unregistered instruction filename to defaults', () => {
    const defaults = getDefaults().reviewContextSources.instructions;
    assert.equal(defaults.includes('README.md'), false);
    assert.equal(defaults.includes('**/README.md'), false);
    assert.equal(registeredInstructionPaths().includes('README.md'), false);
  });

  it('covers every registered instruction target in the docs-instructions prompt', () => {
    const file = readFileSync(join(__dirname, '..', 'prompts', 'review-lanes', 'docs-instructions.md'), 'utf8');
    assert.match(file, /CLAUDE\.md/);
    assert.match(file, /AGENTS\.md/);
    for (const path of registeredInstructionPaths()) {
      const filename = path.split('/').pop();
      assert.match(file, new RegExp(filename.replace('.', '\\.')));
    }
  });
});
