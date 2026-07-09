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

  it('keeps same-line different-column diagnostics distinct and honors explicit report paths', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-columns-'));
    const custom = join(repo, 'artifacts', 'downloaded-aiq.report.json');
    mkdirSync(dirname(custom), { recursive: true });
    const report = JSON.parse(readFileSync(fixturePath, 'utf8'));
    report.stages[0].diagnostics.push({
      code: 'no-debugger',
      file: 'src/changed.ts',
      message: 'Second diagnostic on the same line.',
      range: { startColumn: 12, startLine: 7 },
      severity: 'error',
      source: 'biome',
    });
    writeFileSync(custom, `${JSON.stringify(report, null, 2)}\n`);

    const loaded = loadAiqReviewFindings(repo, ['src/changed.ts'], { reportPath: custom });
    assert.ok(loaded);
    assert.equal(loaded.reportPath, 'artifacts/downloaded-aiq.report.json');
    const sameLine = loaded.findings.filter(finding => finding.path === 'src/changed.ts' && finding.line === 7);
    assert.ok(sameLine.length >= 2);
    assert.equal(new Set(sameLine.map(finding => finding.id)).size, sameLine.length);
    assert.ok(sameLine.some(finding => finding.column === 1));
    assert.ok(sameLine.some(finding => finding.column === 12));
  });

  it('bounds multi-finding prompt context with truncation metadata', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-bound-'));
    const reportPath = copyFixture(repo);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    for (let index = 0; index < 80; index += 1) {
      report.stages[0].diagnostics.push({
        code: `rule-${index}`,
        file: 'src/changed.ts',
        message: `Synthetic finding ${index} ${'x'.repeat(200)}`,
        range: { startColumn: 1, startLine: index + 20 },
        severity: 'warning',
        source: 'fixture',
      });
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const loaded = loadAiqReviewFindings(repo, ['src/changed.ts']);
    const context = aiqReviewContextLines(loaded).join('\n');
    assert.ok(loaded.findings.length > 40);
    assert.match(context, /truncated by the review prompt budget/);
    assert.ok(Buffer.byteLength(context, 'utf8') <= 30_000);
    const findingLines = context.split('\n').filter(line => line.startsWith('AIQ finding:'));
    assert.ok(findingLines.length <= 40);
  });

  it('prefers errors over earlier path-ordered warnings when applying prompt caps', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-severity-'));
    const reportPath = copyFixture(repo);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    report.stages = [{
      stageId: 'lint',
      status: 'failed',
      diagnostics: [
        ...Array.from({ length: 45 }, (_, index) => ({
          code: `warn-${index}`,
          file: `aaa/path-${String(index).padStart(2, '0')}.ts`,
          message: `warning ${index}`,
          range: { startColumn: 1, startLine: 1 },
          severity: 'warning',
          source: 'fixture',
        })),
        {
          code: 'late-error',
          file: 'zzz/late.ts',
          message: 'late severe finding',
          range: { startColumn: 1, startLine: 9 },
          severity: 'error',
          source: 'fixture',
        },
      ],
    }];
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const loaded = loadAiqReviewFindings(repo, []);
    const context = aiqReviewContextLines(loaded).join('\n');
    assert.match(context, /late-error/);
    assert.match(context, /late severe finding/);
  });

  it('uses UTF-8 byte budget and preserves outside-repo report identity', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-aiq-external-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'aie-aiq-external-report-'));
    const externalReport = join(externalRoot, 'downloaded-aiq.report.json');
    const report = JSON.parse(readFileSync(fixturePath, 'utf8'));
    for (let index = 0; index < 20; index += 1) {
      report.stages[0].diagnostics.push({
        code: `wide-${index}`,
        file: 'src/changed.ts',
        message: `${'字'.repeat(400)} finding ${index}`,
        range: { startColumn: 1, startLine: index + 40 },
        severity: 'warning',
        source: 'fixture',
      });
    }
    writeFileSync(externalReport, `${JSON.stringify(report, null, 2)}\n`);
    const loaded = loadAiqReviewFindings(repo, ['src/changed.ts'], { reportPath: externalReport });
    assert.ok(loaded);
    assert.match(loaded.reportPath, /^aiq-report:\/\/downloaded-aiq\.report\.json$/);
    assert.ok(loaded.findings.every(finding => finding.evidenceLink.path.startsWith('aiq-report://')));
    assert.doesNotMatch(loaded.reportPath, /\.qube\/aiq\/out\/aiq\.report\.json/);
    const context = aiqReviewContextLines(loaded).join('\n');
    assert.ok(Buffer.byteLength(context, 'utf8') <= 24_000 + 2_000);
  });
});
