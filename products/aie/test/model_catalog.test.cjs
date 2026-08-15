const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { configuredModelsForHost, reviewModelHostStatuses } = require('../dist/app/model_catalog.js');

describe('review model catalog', () => {
  it('marks configured models served or absent from a live catalog', () => {
    const models = {
      review: { grok: { model: 'grok-4.5', effort: null } },
      economy: {},
      synthesis: {},
    };
    assert.deepEqual(configuredModelsForHost(models, 'grok'), ['grok-4.5']);
    const statuses = reviewModelHostStatuses(models, ['grok', 'codex'], host => (
      host === 'grok'
        ? { host, status: 'ready', models: ['grok-4.5', 'grok-4'], diagnostic: null }
        : { host, status: 'unavailable', models: [], diagnostic: 'no catalog' }
    ));
    assert.deepEqual(statuses.find(item => item.host === 'grok').served, ['grok-4.5']);
    assert.deepEqual(statuses.find(item => item.host === 'grok').absent, []);
    assert.equal(statuses.find(item => item.host === 'codex').listing.status, 'unavailable');
    assert.deepEqual(statuses.find(item => item.host === 'codex').served, []);
  });

  it('does not report served when the catalog is unavailable', () => {
    const models = {
      review: { grok: { model: 'grok-4.5', effort: null } },
      economy: {},
      synthesis: {},
    };
    const statuses = reviewModelHostStatuses(models, ['grok'], () => ({
      host: 'grok',
      status: 'blocked',
      models: ['grok-4.5'],
      diagnostic: 'catalog failed',
    }));
    assert.deepEqual(statuses[0].served, []);
    assert.deepEqual(statuses[0].absent, []);
  });
});
