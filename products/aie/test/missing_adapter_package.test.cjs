'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { isMissingAdapterPackage } = require('../dist/missing_adapter_package.js');

describe('missing adapter package errors', () => {
  it('treats a Windows absolute package path as missing', () => {
    const error = Object.assign(
      new Error("Cannot find package 'C:\\work\\qube\\products\\aie\\node_modules\\@tjalve\\qube-adapter-grok-build\\index.js' imported from C:\\work\\qube\\products\\aie\\dist\\agent_host_adapters.js"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    assert.equal(isMissingAdapterPackage(error, '@tjalve/qube-adapter-grok-build'), true);
  });

  it('does not treat an unrelated failure as missing', () => {
    assert.equal(isMissingAdapterPackage(new Error('permission denied'), '@tjalve/qube-adapter-grok-build'), false);
  });
});
