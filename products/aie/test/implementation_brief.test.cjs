const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildImplementationBrief, extractExpectedPaths, formatBriefLines } = require('../dist/brief/index.js');
const { getDefaults } = require('../dist/config/index.js');
const { loadRiskCardCatalog } = require('../dist/risk_cards/index.js');

function briefConfig() {
  const config = structuredClone(getDefaults());
  config.reviewProfile = 'local-focused';
  config.reviewLanes = [
    { id: 'issue-compliance', required: 'always', match: ['**/*'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
    { id: 'security', required: 'when-matched', match: ['**/*.ts'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
  ];
  return config;
}

const MULTI_MODE_BODY = [
  '## Context',
  '',
  'Support the GitHub and GitLab providers with OAuth and API key auth modes across `products/aie/src/app/start_work.ts`.',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] Integration test covers each provider and auth-mode combination.',
  '- [ ] Malformed provider payloads fail loudly with an error message and a unit test asserts the rejection.',
].join('\n');

const SINGLE_MODE_BODY = [
  '## Context',
  '',
  'Improve the GitHub start flow.',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] Unit test asserts the start flow output for a ready issue.',
].join('\n');

function sectionOrder(lines) {
  const joined = lines.join('\n');
  return [
    joined.indexOf('Obligations:'),
    joined.indexOf('Behavior matrix'),
    joined.indexOf('Risk cards'),
    joined.indexOf('Expected review lanes'),
    joined.indexOf('Negative cases'),
    joined.indexOf('Open ambiguities'),
  ];
}

describe('implementation brief builder', () => {
  it('renders all six sections in order for a multi-mode issue', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    for (const key of ['obligations', 'matrix', 'riskCards', 'expectedLanes', 'negativeCases', 'ambiguities']) {
      assert.ok(key in brief, `missing ${key}`);
    }
    const order = sectionOrder(formatBriefLines(brief));
    for (let index = 0; index < order.length; index += 1) {
      assert.ok(order[index] >= 0, `section ${index} missing`);
      if (index > 0) assert.ok(order[index] > order[index - 1], `section ${index} out of order`);
    }
  });

  it('classifies verification kinds from stated criteria', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.equal(brief.obligations.length, 2);
    assert.equal(brief.obligations[0].kind, 'integration');
    assert.equal(brief.obligations[1].kind, 'unit');
  });

  it('enumerates matrix rows for selected dimensions only', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.ok(brief.matrix, 'expected a matrix');
    assert.deepEqual(brief.matrix.dimensions.map(dimension => dimension.name), ['provider', 'auth mode']);
    assert.deepEqual(brief.matrix.dimensions[0].values, ['github', 'gitlab']);
    assert.deepEqual(brief.matrix.dimensions[1].values, ['oauth', 'api key']);
    assert.equal(brief.matrix.rows.length, 4);
    assert.equal(brief.matrix.omittedRows, 0);
    const names = brief.matrix.dimensions.map(dimension => dimension.name);
    assert.ok(!names.includes('host'));
    assert.ok(!names.includes('platform'));
    assert.ok(!names.includes('lifecycle state'));
  });

  it('renders no matrix for a single-mode issue', () => {
    const brief = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    assert.equal(brief.matrix, null);
    assert.ok(formatBriefLines(brief).join('\n').includes('Behavior matrix: none'));
  });

  it('reports no ambiguities for a fully specified issue', () => {
    const brief = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    assert.deepEqual(brief.ambiguities, []);
    assert.ok(formatBriefLines(brief).join('\n').includes('Open ambiguities: none detected.'));
  });

  it('reports unspecified verification kinds and unspecified failure behavior as ambiguities', () => {
    const body = [
      '- [ ] The command exposes the new output.',
      '- [ ] Malformed payloads are rejected.',
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Ambiguous work', body, config: briefConfig() });
    assert.equal(brief.obligations[0].kind, 'unspecified');
    assert.ok(brief.ambiguities.some(entry => entry.includes('No stated verification kind') && entry.includes('exposes the new output')));
    assert.ok(brief.ambiguities.some(entry => entry.includes('Failure behavior is not specified') && entry.includes('Malformed payloads')));
  });

  it('flags dimensions mentioned but not bounded', () => {
    const body = 'Handle every provider consistently.\n\n- [ ] Unit test asserts consistent handling.';
    const brief = buildImplementationBrief({ title: 'Unbounded providers', body, config: briefConfig() });
    assert.equal(brief.matrix, null);
    assert.ok(brief.ambiguities.some(entry => entry.includes('mentions providers without bounding them')));
  });

  it('is deterministic across runs', () => {
    const first = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    const second = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.deepEqual(first, second);
    assert.equal(formatBriefLines(first).join('\n'), formatBriefLines(second).join('\n'));
  });

  it('bounds a maximum-size issue with explicit omission markers', () => {
    const criteria = [];
    for (let index = 0; index < 40; index += 1) {
      criteria.push(`- [ ] Criterion ${index} ${'detail '.repeat(60)}ends here.`);
    }
    const body = [
      'Cover github gitlab linear jira providers with oauth, api key, ssh, and device code auth modes on windows, macos, and linux platforms.',
      '',
      ...criteria,
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Maximum size', body, config: briefConfig() });
    assert.equal(brief.obligations.length, 30);
    assert.equal(brief.omittedObligations, 10);
    for (const obligation of brief.obligations) {
      assert.ok(obligation.criterion.length <= 240 + ' [truncated]'.length);
      assert.ok(obligation.criterion.endsWith('[truncated]'));
    }
    assert.ok(brief.matrix);
    assert.equal(brief.matrix.rows.length, 24);
    assert.equal(brief.matrix.omittedRows, 24);
    const joined = formatBriefLines(brief).join('\n');
    assert.ok(joined.includes('(+10 obligations omitted)'));
    assert.ok(joined.includes('(+24 rows omitted)'));
  });

  it('renders no omission markers for a small issue', () => {
    const brief = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    const joined = formatBriefLines(brief).join('\n');
    assert.ok(!joined.includes('omitted)'));
    assert.ok(!joined.includes('[truncated]'));
  });

  it('degrades cleanly to a minimal brief without fabricating obligations', () => {
    const brief = buildImplementationBrief({ title: 'Wording pass', body: 'contestant latest errorship pretest wording improvements.', config: briefConfig() });
    assert.equal(brief.minimal, true);
    assert.deepEqual(brief.obligations, []);
    assert.equal(brief.matrix, null);
    assert.deepEqual(brief.riskCards, []);
    const joined = formatBriefLines(brief).join('\n');
    assert.ok(joined.includes('Minimal brief:'));
    assert.ok(joined.includes('(none stated in the issue checklist)'));
  });

  it('activates zero risk cards when nothing matches', () => {
    const brief = buildImplementationBrief({ title: 'Wording pass', body: 'contestant latest errorship pretest\n\n- [ ] The introduction wording reads clearly for newcomers.', config: briefConfig() });
    assert.deepEqual(brief.riskCards, []);
    assert.ok(formatBriefLines(brief).join('\n').includes('Risk cards: none activated.'));
  });

  it('caps activated risk cards at five by rank and renders implementer faces only', () => {
    const body = 'status error provider auth stale cache timeout lock path malformed package test\n\n- [ ] Unit test asserts behavior.';
    const brief = buildImplementationBrief({ title: 'Keyword soup', body, config: briefConfig() });
    assert.equal(brief.riskCards.length, 5);
    assert.deepEqual(brief.riskCards.map(card => card.id), [
      'truthful-state-transitions',
      'oracle-quality',
      'trust-identity-boundaries',
      'filesystem-boundaries',
      'mode-provider-matrix',
    ]);
    const catalog = loadRiskCardCatalog();
    const joined = formatBriefLines(brief).join('\n');
    for (const rendered of brief.riskCards) {
      const card = catalog.find(candidate => candidate.id === rendered.id);
      assert.equal(rendered.implementerFace, card.implementerFace.trim());
      const reviewerOpening = card.reviewerFace.trim().slice(0, 40);
      assert.ok(!joined.includes(reviewerOpening), `reviewer face leaked for ${rendered.id}`);
    }
  });

  it('predicts review lanes from expected paths using lane policy', () => {
    const multiMode = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.deepEqual(multiMode.expectedLanes.map(lane => lane.lane), ['issue-compliance', 'security']);
    const singleMode = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    assert.deepEqual(singleMode.expectedLanes.map(lane => lane.lane), ['issue-compliance']);
    for (const lane of multiMode.expectedLanes) {
      assert.ok(lane.heuristic.length > 0);
    }
    assert.ok(formatBriefLines(multiMode).join('\n').includes('design for them now'));
  });

  it('derives negative cases from cards and failure-bearing obligations', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.ok(brief.negativeCases.some(entry => entry.startsWith('Write a negative test for: "Malformed provider payloads')));
    assert.ok(brief.negativeCases.length > 0);
  });

  it('renders layout ownership for a multi-package issue and omits it without layout data', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
        { id: 'qube-core', path: 'packages/qube-core', kind: 'package', packageName: '@tjalve/qube-core', packageManager: 'pnpm', gates: [] },
        { id: 'adapter-github', path: 'adapters/github', kind: 'package', packageName: '@tjalve/qube-adapter-github', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [{ path: 'dist', reason: 'Generated package build output path exists.' }],
      vendorPaths: [{ path: 'vendor', reason: 'Vendored dependency path exists.' }],
      warnings: [],
    };
    const body = [
      'Move the contract into `packages/qube-core/src/contracts.ts` and consume it from `products/aie/src/view.ts`.',
      '',
      '- [ ] Unit test asserts the shared contract is consumed, not duplicated.',
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Share the contract', body, config: briefConfig(), layout });
    assert.ok(brief.layout, 'expected a layout section');
    assert.equal(brief.layout.derived, true);
    assert.deepEqual(brief.layout.owningProjects.map(project => `${project.name}:${project.role}`), ['@tjalve/aie:product', '@tjalve/qube-core:package']);
    assert.ok(brief.layout.boundaryRules.some(rule => rule.includes('Provider-neutral contracts live in core packages')));
    assert.ok(brief.layout.boundaryRules.some(rule => rule.includes('Products consume core contracts')));
    assert.ok(brief.layout.boundaryRules.some(rule => rule.includes('Test support stays inside its own project boundaries')), 'a unit-test obligation implies the test-boundary directive');
    assert.deepEqual(brief.layout.doNotEditPaths, [
      'dist (Generated package build output path exists.)',
      'vendor (Vendored dependency path exists.)',
    ]);
    const rendered = formatBriefLines(brief).join('\n');
    assert.ok(rendered.includes('Layout ownership:'));
    assert.ok(rendered.includes('Do-not-edit paths:'));

    const withoutLayout = buildImplementationBrief({ title: 'Share the contract', body, config: briefConfig() });
    assert.equal(withoutLayout.layout, null);
    assert.ok(!formatBriefLines(withoutLayout).join('\n').includes('Layout ownership'));

    const nonCode = buildImplementationBrief({
      title: 'Rewrite the guide',
      body: 'Improve wording in `docs/guide.md` only.\n\n- [ ] The guide reads clearly. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(nonCode.layout, null, 'documentation-only work renders no layout section');
  });

  it('derives root ownership for single-app layouts without fabricating it from punctuation', () => {
    const layout = {
      kind: 'single-app-service',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'field-notes', path: '.', kind: 'app', packageName: 'field-notes', packageManager: 'npm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const owned = buildImplementationBrief({
      title: 'Harden the server entry',
      body: 'Refactor `src/server.ts` to reject malformed requests loudly.\n\n- [ ] Unit test asserts malformed requests are rejected loudly with an error message.',
      config: briefConfig(),
      layout,
    });
    assert.ok(owned.layout && owned.layout.derived, 'expected root project ownership from a contained code path');
    assert.deepEqual(owned.layout.owningProjects.map(project => `${project.name}:${project.role}`), ['field-notes:app']);

    const punctuationOnly = buildImplementationBrief({
      title: 'Improve resilience',
      body: 'contestant latest errorship pretest resilience. Improvements follow. Thanks.\n\n- [ ] Unit test asserts resilient behavior.',
      config: briefConfig(),
      layout,
    });
    assert.ok(punctuationOnly.layout, 'expected a layout section');
    assert.equal(punctuationOnly.layout.derived, false, 'periods in prose must not fabricate root ownership');
    assert.deepEqual(punctuationOnly.layout.owningProjects, []);
  });

  it('keeps inspected kinds for nested projects and picks the most specific owner', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'root', path: '.', kind: 'workspace', packageName: 'monorepo-root', packageManager: 'pnpm', gates: [] },
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
        { id: 'html-css', path: 'products/aiq/test-projects/html-css', kind: 'app', packageName: null, packageManager: null, gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Touch nested app',
      body: 'Edit `products/aiq/test-projects/html-css/index.html` and `products/aie/src/view.ts`.\n\n- [ ] Unit test asserts both surfaces render.',
      config: briefConfig(),
      layout,
    });
    assert.ok(brief.layout && brief.layout.derived);
    const roles = Object.fromEntries(brief.layout.owningProjects.map(project => [project.path, project.role]));
    assert.equal(roles['products/aiq/test-projects/html-css'], 'app', 'nested project must keep its inspected kind');
    assert.equal(roles['products/aie'], 'product');
    assert.equal(roles['.'], undefined, 'root project must not own paths a deeper project owns');
  });

  it('never fabricates root ownership for unmatched paths in a multi-project workspace', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'root', path: '.', kind: 'workspace', packageName: 'monorepo-root', packageManager: 'pnpm', gates: [] },
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Touch an unrecognized surface',
      body: 'Edit `mystery/deep/thing.ts` to render output.\n\n- [ ] Unit test asserts the surface renders.',
      config: briefConfig(),
      layout,
    });
    assert.ok(brief.layout, 'expected a layout section');
    assert.equal(brief.layout.derived, false, 'unmatched path must yield could-not-derive, not a fabricated root owner');
    assert.deepEqual(brief.layout.owningProjects, []);

    const oneProjectWorkspace = buildImplementationBrief({
      title: 'Touch an unrecognized surface',
      body: 'Edit `mystery/deep/thing.ts` to render output.\n\n- [ ] Unit test asserts the surface renders.',
      config: briefConfig(),
      layout: { ...layout, projects: [layout.projects[0]] },
    });
    assert.ok(oneProjectWorkspace.layout);
    assert.equal(oneProjectWorkspace.layout.derived, false, 'a one-project workspace root must not claim unmatched paths');
  });

  it('omits the layout section for documentation-only work inside a known project', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [{ path: 'dist', reason: 'Generated package build output path exists.' }],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Update the product guide',
      body: 'Rewrite `products/aie/docs/guide.md` for clarity.\n\n- [ ] The guide reads clearly. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(brief.layout, null, 'documentation work inside a project must not render ownership');
  });

  it('caps owning projects with an omission marker', () => {
    const projects = Array.from({ length: 10 }, (_, index) => ({
      id: `pkg-${index}`,
      path: `packages/pkg-${index}`,
      kind: 'package',
      packageName: `@scope/pkg-${index}`,
      packageManager: 'pnpm',
      gates: [],
    }));
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects,
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const body = [
      projects.map(project => `Touch \`${project.path}/src/index.ts\`.`).join(' '),
      '',
      '- [ ] Unit test asserts every package builds.',
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Wide refactor', body, config: briefConfig(), layout });
    assert.ok(brief.layout && brief.layout.derived);
    assert.equal(brief.layout.owningProjects.length, 8);
    assert.equal(brief.layout.omittedProjects, 2);
    assert.ok(formatBriefLines(brief).join('\n').includes('(+2 projects omitted)'));
  });

  it('owns workspace-root files, skips pathless docs work, and keeps the adapter directive owner-gated', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'root', path: '.', kind: 'workspace', packageName: 'monorepo-root', packageManager: 'pnpm', gates: [] },
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const rootFiles = buildImplementationBrief({
      title: 'Pin the workflow actions',
      body: 'Edit `.github/workflows/ci.yml` and the root `package.json` provider pins.\n\n- [ ] Unit test asserts the workflow pins are exact.',
      config: briefConfig(),
      layout,
    });
    assert.ok(rootFiles.layout && rootFiles.layout.derived, 'workspace-root files must be owned by the root project');
    assert.deepEqual(rootFiles.layout.owningProjects.map(project => project.path), ['.']);
    assert.ok(!rootFiles.layout.boundaryRules.some(rule => rule.includes('owning adapter')), 'the word provider alone must not trigger the adapter directive');

    const pathlessDocs = buildImplementationBrief({
      title: 'Improve the README',
      body: 'Rewrite the README wording for @tjalve/aie so newcomers can start faster.\n\n- [ ] The README reads clearly. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(pathlessDocs.layout, null, 'documentation work without paths must not render ownership from name mentions');
  });

  it('owns nested paths in generated-vendor-heavy single-app repos and ignores traversal and unknown hidden paths', () => {
    const singleAppVendor = {
      kind: 'generated-vendor-heavy',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'field-notes', path: '.', kind: 'app', packageName: 'field-notes', packageManager: 'npm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [{ path: 'dist', reason: 'Generated output path exists.' }],
      vendorPaths: [{ path: 'vendor', reason: 'Vendored dependency path exists.' }],
      warnings: [],
    };
    const owned = buildImplementationBrief({
      title: 'Harden the exporter',
      body: 'Refactor `src/exporter.ts` to reject malformed rows loudly.\n\n- [ ] Unit test asserts malformed rows are rejected loudly with an error message.',
      config: briefConfig(),
      layout: singleAppVendor,
    });
    assert.ok(owned.layout && owned.layout.derived, 'a lone root app in a vendor-heavy repo still owns its source paths');
    assert.deepEqual(owned.layout.owningProjects.map(project => project.name), ['field-notes']);

    const workspace = {
      ...singleAppVendor,
      kind: 'javascript-typescript-workspace',
      projects: [
        { id: 'root', path: '.', kind: 'workspace', packageName: 'monorepo-root', packageManager: 'pnpm', gates: [] },
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
    };
    const suspicious = buildImplementationBrief({
      title: 'Touch odd paths',
      body: 'Edit `src/../../../secrets/keys.ts` and `.mystery/hidden.ts` carefully.\n\n- [ ] Unit test asserts nothing leaks.',
      config: briefConfig(),
      layout: workspace,
    });
    assert.ok(suspicious.layout, 'expected a layout section');
    assert.equal(suspicious.layout.derived, false, 'traversal tokens and unknown hidden directories must not claim ownership');
  });

  it('rejects absolute, UNC, and scoped-package tokens and treats rst documentation as docs-only', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const paths = extractExpectedPaths('Check `/etc/passwd.txt`, `C:/secrets/keys.ts`, `\\\\server\\share\\thing.ts`, and `@tjalve/aie` here.');
    assert.deepEqual(paths, [], 'absolute, UNC, and scoped-package tokens are not repository surfaces');

    const urlPaths = extractExpectedPaths('See `https://github.com/example/repo/blob/main/file.ts` and docs.example.com/guide/setup.ts for details.');
    assert.deepEqual(urlPaths, [], 'URLs and hostname fragments are not repository surfaces');

    const manifest = extractExpectedPaths('Update `package.json` and `pnpm-lock.yaml` pins.');
    assert.deepEqual(manifest, ['package.json', 'pnpm-lock.yaml'], 'top-level manifest tokens are workspace-root surfaces');

    const rstDocs = buildImplementationBrief({
      title: 'Update the manual',
      body: 'Rewrite `products/aie/manual/setup.rst` for the new flow.\n\n- [ ] The manual describes the new flow. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(rstDocs.layout, null, 'rst documentation work must not render ownership');

    const changelog = buildImplementationBrief({
      title: 'Draft the release notes',
      body: 'Write the changelog entry for the next release of @tjalve/aie.\n\n- [ ] The changelog entry lists the shipped changes. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(changelog.layout, null, 'pathless release-notes work must not render ownership');
  });

  it('omits non-code coordination work and ignores generic root ids in prose', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'root', path: '.', kind: 'workspace', packageName: 'monorepo-root', packageManager: 'pnpm', gates: [] },
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const coordination = buildImplementationBrief({
      title: 'Schedule the release window',
      body: 'Coordinate the next release window with stakeholders and confirm the sign-off order.\n\n- [ ] The sign-off order is confirmed. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(coordination.layout, null, 'coordination work without code evidence must render no layout section');

    const pathlessRefactor = buildImplementationBrief({
      title: 'Simplify the exports',
      body: 'Refactor the @tjalve/aie exports so consumers see one entry surface. The behavior stays identical. Confirmed by inspection.',
      config: briefConfig(),
      layout,
    });
    assert.ok(pathlessRefactor.layout && pathlessRefactor.layout.derived, 'pathless code work naming a package must render its owner');
    assert.deepEqual(pathlessRefactor.layout.owningProjects.map(project => project.path), ['products/aie']);

    const packageCoordination = buildImplementationBrief({
      title: 'Plan the next release',
      body: 'Coordinate the @tjalve/aie release sign-off with stakeholders.\n\n- [ ] The sign-off order is confirmed. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.equal(packageCoordination.layout, null, 'coordination work naming a package must not render ownership');

    const rootProse = buildImplementationBrief({
      title: 'Investigate flaky exports',
      body: 'Investigate the root cause of flaky exports in `products/aie/src/export.ts`.\n\n- [ ] Unit test asserts exports are stable.',
      config: briefConfig(),
      layout,
    });
    assert.ok(rootProse.layout && rootProse.layout.derived);
    assert.deepEqual(rootProse.layout.owningProjects.map(project => project.path), ['products/aie'], 'the word root in prose must not add the root project');

    const unknownKind = buildImplementationBrief({
      title: 'Touch a nested path',
      body: 'Edit `src/deep/module.ts` to render output.\n\n- [ ] Unit test asserts the module renders.',
      config: briefConfig(),
      layout: { ...layout, kind: 'unknown', projects: [layout.projects[0]] },
    });
    assert.ok(unknownKind.layout);
    assert.equal(unknownKind.layout.derived, false, 'an unknown-kind root-only layout must not claim unmatched paths');
  });

  it('keeps layout ownership for pathless code work that mentions documentation terms', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Fix the README badge generator',
      body: 'The README badge generator in @tjalve/aie emits stale counts.\n\n- [ ] Unit test asserts the badge generator emits current counts.',
      config: briefConfig(),
      layout,
    });
    assert.ok(brief.layout, 'expected a layout section');
    assert.equal(brief.layout.derived, true, 'code work mentioning README must keep ownership from the project mention');
    assert.deepEqual(brief.layout.owningProjects.map(project => project.name), ['@tjalve/aie']);
  });

  it('activates the test-boundary directive from regression prose outside the checklist', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Harden the selector',
      body: 'Refactor `products/aie/src/brief/build.ts` for clarity. Write a regression test for each defaulted allocation branch.\n\n- [ ] The selector output stays identical for existing inputs. Verified by artifact review.',
      config: briefConfig(),
      layout,
    });
    assert.ok(brief.layout && brief.layout.derived);
    assert.ok(brief.layout.boundaryRules.some(rule => rule.includes('Test support stays inside its own project boundaries')), 'regression-test prose must activate the test directive');
  });

  it('reserves the core directive for core packages', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'qube-cli', path: 'packages/qube-cli', kind: 'package', packageName: '@tjalve/qube-cli', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Extend the command registry',
      body: 'Edit `packages/qube-cli/src/registry/index.ts` to expose the new command shape.\n\n- [ ] Unit test asserts the registry exposes the new command shape.',
      config: briefConfig(),
      layout,
    });
    assert.ok(brief.layout && brief.layout.derived);
    assert.ok(!brief.layout.boundaryRules.some(rule => rule.includes('Provider-neutral contracts live in core packages')), 'a non-core package must not trigger the core directive');
  });

  it('derives boundary rules from capped-out owners too', () => {
    const projects = [
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `pkg-${index}`,
        path: `packages/pkg-${index}`,
        kind: 'package',
        packageName: `@scope/pkg-${index}`,
        packageManager: 'pnpm',
        gates: [],
      })),
      { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
    ];
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects,
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const body = [
      projects.map(project => `Touch \`${project.path}/src/index.ts\`.`).join(' '),
      '',
      '- [ ] Unit test asserts every project builds.',
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Wide refactor', body, config: briefConfig(), layout });
    assert.ok(brief.layout && brief.layout.derived);
    assert.equal(brief.layout.omittedProjects, 2);
    assert.ok(!brief.layout.owningProjects.some(project => project.role === 'product'), 'the product owner is beyond the cap in this fixture');
    assert.ok(brief.layout.boundaryRules.some(rule => rule.includes('Products consume core contracts')), 'rules must reflect capped-out owners');
  });

  it('states could-not-derive instead of guessing and omits empty do-not-edit entries', () => {
    const layout = {
      kind: 'javascript-typescript-workspace',
      root: 'C:/repo',
      remotes: [],
      rootMarkers: [],
      projects: [
        { id: 'aie', path: 'products/aie', kind: 'package', packageName: '@tjalve/aie', packageManager: 'pnpm', gates: [] },
      ],
      packageManagers: [],
      lockfiles: [],
      ciHints: [],
      generatedPaths: [],
      vendorPaths: [],
      warnings: [],
    };
    const brief = buildImplementationBrief({
      title: 'Improve resilience',
      body: 'contestant latest errorship pretest resilience improvements.\n\n- [ ] Unit test asserts resilient behavior.',
      config: briefConfig(),
      layout,
    });
    assert.ok(brief.layout, 'expected a layout section with the could-not-derive statement');
    assert.equal(brief.layout.derived, false);
    assert.deepEqual(brief.layout.owningProjects, []);
    assert.deepEqual(brief.layout.boundaryRules, []);
    assert.deepEqual(brief.layout.doNotEditPaths, []);
    const rendered = formatBriefLines(brief).join('\n');
    assert.ok(rendered.includes('Expected surfaces could not be derived'));
    assert.ok(!rendered.includes('Do-not-edit paths:'));
    assert.ok(!rendered.includes('Owning projects:'));

    const again = buildImplementationBrief({
      title: 'Improve resilience',
      body: 'contestant latest errorship pretest resilience improvements.\n\n- [ ] Unit test asserts resilient behavior.',
      config: briefConfig(),
      layout,
    });
    assert.deepEqual(brief, again, 'layout projection must be deterministic');
  });

  it('extracts expected paths from backticked and bare path tokens', () => {
    const paths = extractExpectedPaths('Edit `products/aie/src/view.ts` and products/aie/test/view.test.cjs but not `a spaced token`, `prompts/**/*.md`, or plain words.');
    assert.ok(paths.includes('products/aie/src/view.ts'));
    assert.ok(paths.includes('products/aie/test/view.test.cjs'));
    assert.ok(!paths.some(path => path.includes(' ')));
    assert.ok(!paths.some(path => path.includes('*')));
  });

  it('rejects slash-separated prose and placeholder templates as expected paths', () => {
    const paths = extractExpectedPaths([
      'Matrix fixtures cover a multi-provider/multi-mode issue.',
      'No layout/ownership section in this issue.',
      'Issue branches follow `issue/<number>-<slug>` conventions.',
      'A real reference: products/aie/src/app/start_work.ts stays.',
    ].join('\n'));
    assert.deepEqual(paths, ['products/aie/src/app/start_work.ts']);
  });
});
