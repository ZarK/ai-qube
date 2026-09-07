import type { CriterionIdentity } from '../checklist.js';

export interface CriterionProofEntry {
  criterion: CriterionIdentity;
  implementedAt: string;
  provenBy: string;
  negativeCase: string;
  section: string;
  citedPaths: string[];
}

export function readCriterionProof(body: string, criterion: CriterionIdentity): { entry: CriterionProofEntry | null; errors: string[] } {
  const map = body.match(/(?:^|\n)##\s+Criterion-to-proof map\s*\n([\s\S]*?)(?=\n##\s|$)/iu)?.[1] ?? '';
  if (!map) return { entry: null, errors: ['The criterion-to-proof map is missing.'] };
  const sections = [...map.matchAll(/^###\s+Criterion\s+(\d+):\s*(.*)\r?\n([\s\S]*?)(?=^###\s+Criterion\s+\d+:|(?![\s\S]))/gimu)]
    .map(match => ({ index: Number(match[1]), text: match[2].trim(), section: match[0].trim(), fields: match[3] }));
  const indexed = sections.filter(section => section.index === criterion.index);
  const exact = indexed.filter(section => section.text === criterion.text);
  const errors: string[] = [];
  if (indexed.some(section => section.text !== criterion.text)) errors.push(`Criterion ${criterion.index} has mismatched text.`);
  if (exact.length > 1) errors.push(`Criterion ${criterion.index} has duplicate proof sections.`);
  if (exact.length !== 1) return { entry: null, errors: errors.length > 0 ? errors : [`Criterion ${criterion.index} is not mapped.`] };
  const selected = exact[0];
  const implementedAt = field(selected.fields, 'Implemented at');
  const provenBy = field(selected.fields, 'Proven by');
  const negativeCase = field(selected.fields, 'Negative case');
  for (const [name, value] of [['Implemented at', implementedAt], ['Proven by', provenBy], ['Negative case', negativeCase]] as const) {
    if (!value || /\[(?:UNFILLED|TODO)|<[^>]+>|TBD/iu.test(value)) errors.push(`Criterion ${criterion.index} has an incomplete ${name} field.`);
  }
  const citedPaths = [...new Set([...selected.section.matchAll(/`([^`\n]+)`/gu)]
    .map(match => match[1].trim())
    .filter(value => /^[\w@./-]+\.[a-z0-9]{1,10}(?::\d+)?$/iu.test(value))
    .map(value => value.replace(/:\d+$/u, '')))];
  return {
    entry: { criterion, implementedAt, provenBy, negativeCase, section: selected.section, citedPaths },
    errors,
  };
}

function field(section: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^[-*]\\s+(?:\\*\\*)?${escaped}:(?:\\*\\*)?\\s*(.*)$`, 'imu').exec(section)?.[1]?.trim() ?? '';
}
