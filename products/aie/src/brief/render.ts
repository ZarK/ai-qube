import type { ImplementationBrief } from './types.js';

export function formatBriefLines(brief: ImplementationBrief): string[] {
  const lines: string[] = [];
  lines.push('Implementation brief:');
  if (brief.minimal) {
    lines.push('  Minimal brief: the issue has no checklist obligations, matrix signals, or activated risk cards.');
  }

  lines.push('  Obligations:');
  if (brief.obligations.length === 0) {
    lines.push('    (none stated in the issue checklist)');
  }
  for (const obligation of brief.obligations) {
    lines.push(`    - [${obligation.kind}] ${obligation.criterion}`);
  }
  if (brief.omittedObligations > 0) lines.push(`    (+${brief.omittedObligations} obligations omitted)`);

  if (brief.matrix === null) {
    lines.push('  Behavior matrix: none — the issue selects a single mode.');
  } else {
    lines.push('  Behavior matrix:');
    lines.push(`    Dimensions: ${brief.matrix.dimensions.map(dimension => `${dimension.name} (${dimension.values.join(', ')})`).join(' × ')}`);
    for (const row of brief.matrix.rows) {
      lines.push(`    - ${row.join(' | ')}`);
    }
    if (brief.matrix.omittedRows > 0) lines.push(`    (+${brief.matrix.omittedRows} rows omitted)`);
  }

  if (brief.riskCards.length === 0) {
    lines.push('  Risk cards: none activated.');
  } else {
    lines.push('  Risk cards:');
    for (const card of brief.riskCards) {
      lines.push(`    - ${card.id}: ${card.title}`);
      lines.push(`      ${card.implementerFace}`);
    }
  }

  lines.push('  Expected review lanes — this change will be reviewed against these; design for them now:');
  if (brief.expectedLanes.length === 0) {
    lines.push('    (no lanes configured)');
  }
  for (const lane of brief.expectedLanes) {
    lines.push(`    - ${lane.lane}: ${lane.heuristic}`);
  }

  if (brief.negativeCases.length === 0) {
    lines.push('  Negative cases: none derived from the issue or activated cards.');
  } else {
    lines.push('  Negative cases:');
    for (const negativeCase of brief.negativeCases) {
      lines.push(`    - ${negativeCase}`);
    }
    if (brief.omittedNegativeCases > 0) lines.push(`    (+${brief.omittedNegativeCases} negative cases omitted)`);
  }

  if (brief.ambiguities.length === 0) {
    lines.push('  Open ambiguities: none detected.');
  } else {
    lines.push('  Open ambiguities — resolve each before coding:');
    for (const ambiguity of brief.ambiguities) {
      lines.push(`    - ${ambiguity}`);
    }
    if (brief.omittedAmbiguities > 0) lines.push(`    (+${brief.omittedAmbiguities} ambiguities omitted)`);
  }

  return lines;
}
