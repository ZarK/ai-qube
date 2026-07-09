const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const { aiqReviewContextLines, loadAiqReviewFindings } = require('../dist/app/aiq_review_findings.js');

const fixturePath = join(__dirname, 'fixtures', 'aiq-report.json');

function copyFixture(repo, reportPath = join('.qube', 'aiq', 'out', 'aiq.report.json')) {
  const target = join(repo, reportPath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(fixturePath, target);
  return target;
}

describe('AIQ review findings', () => {
  it('loads, redacts, deduplicates, and scopes canonical report findings to changed files', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-findings-'));
    const reportPath = copyFixture(repo);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.stages[0].diagnostics[0].message = `Remove debugger before shipping ${['ghp', 'abcdefghijklmnopqrstuvwxyz'].join('_')}.`;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const first = loadAiqReviewFindings(repo, ['src/changed.ts']);
    const second = loadAiqReviewFindings(repo, ['src/changed.ts']);

    assert.ok(first);
    assert.deepEqual(second, first);
    assert.equal(first.reportPath, '.qube/aiq/out/aiq.report.json');
    assert.equal(first.scopedToChangedPaths, true);
    assert.equal(first.totalFindingCount, 3);
    assert.equal(first.omittedFindingCount, 1);
    assert.equal(first.findings.length, 2);
    assert.ok(first.findings.every(finding => finding.path === 'src/changed.ts'));
    assert.ok(first.findings.every(finding => /^aiq:[a-f0-9]{64}$/.test(finding.id)));
    assert.ok(first.findings.every(finding => finding.contentHash === finding.evidenceLink.sha256));
    assert.ok(first.findings.every(finding => finding.evidenceLink.kind === 'aiq-finding'));
    assert.ok(first.findings.some(finding => finding.rule === 'biome/no-debugger' && finding.line === 7));
    assert.ok(first.findings.some(finding => finding.message.includes('[REDACTED]')));
    assert.ok(first.findings.every(finding => !finding.message.includes('ghp_')));
  });

  it('renders verification and duplicate-linkage guidance using the existing artifacts shape', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-context-'));
    copyFixture(repo);
    const report = loadAiqReviewFindings(repo, ['src/changed.ts']);

    const context = aiqReviewContextLines(report).join('\n');

    assert.match(context, /VERIFY against the current head/);
    assert.match(context, /add its evidenceLink object verbatim to evidence artifacts/);
    assert.match(context, /Do not add a supplied AIQ defect to findings\[\] as a new finding/);
    assert.match(context, /"kind":"aiq-finding"/);
    assert.match(context, /"path":"src\/changed\.ts"/);
    assert.match(context, /"line":7/);
    assert.match(context, /"rule":"biome\/no-debugger"/);
  });

  it('falls back to a valid legacy report and ignores unreadable report data without failing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-fallback-'));
    const canonical = join(repo, '.qube', 'aiq', 'out', 'aiq.report.json');
    mkdirSync(dirname(canonical), { recursive: true });
    writeFileSync(canonical, '{ malformed');
    copyFixture(repo, join('.aiq', 'out', 'aiq.report.json'));

    const legacy = loadAiqReviewFindings(repo, ['src/changed.ts']);
    assert.equal(legacy?.reportPath, '.aiq/out/aiq.report.json');

    writeFileSync(join(repo, '.aiq', 'out', 'aiq.report.json'), '{}');
    assert.equal(loadAiqReviewFindings(repo, ['src/changed.ts']), null);
    assert.deepEqual(aiqReviewContextLines(null), []);
  });
});
