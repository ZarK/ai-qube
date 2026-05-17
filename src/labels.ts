import { runGh, GhExec, parseGhJson } from './gh';
import { Config } from './config';

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export interface LabelPlan {
  created: LabelSpec[];
  updated: LabelSpec[];
  unchanged: LabelSpec[];
  skipped: LabelSpec[];
}

const DEFAULT_LABEL_SPECS: Record<string, Omit<LabelSpec, 'name'>> = {
  'P1-Critical': { color: 'b60205', description: 'Highest priority work; do before lower priorities.' },
  'P2-High': { color: 'd93f0b', description: 'High priority work.' },
  'P3-Medium': { color: 'fbca04', description: 'Medium priority work.' },
  'P4-Low': { color: '0e8a16', description: 'Low priority work.' },
  'S-Ready': { color: '0e8a16', description: 'Ready to start when no earlier ready work exists.' },
  'S-InProgress': { color: '1d76db', description: 'Currently being worked.' },
  'S-Blocked': { color: 'd93f0b', description: 'Blocked by another issue or repository state.' },
  'S-Blocking': { color: '5319e7', description: 'Blocks another issue.' },
  'C-Architecture': { color: '5319e7', description: 'Architecture and shared design.' },
  'C-Backend': { color: '1d76db', description: 'Backend or service behavior.' },
  'C-Frontend': { color: 'c2e0c6', description: 'Frontend or UI behavior.' },
  'C-Testing': { color: 'bfdadc', description: 'Tests, fixtures, and verification.' },
  'C-Tooling': { color: '006b75', description: 'CLI, scripts, automation, and developer tooling.' },
  'C-Docs': { color: '0075ca', description: 'Documentation.' },
  'C-DevEx': { color: '7057ff', description: 'Developer experience and usability.' },
  'C-CI': { color: '0e8a16', description: 'Continuous integration and automation.' },
  'C-Security': { color: 'd73a4a', description: 'Security and supply-chain safety.' },
  'C-Data': { color: 'a2eeef', description: 'Data and storage behavior.' },
};

const DEFAULT_CUSTOM_COLOR = 'ededed';
const DEFAULT_CUSTOM_DESCRIPTION = 'Additional component label configured for this repository.';

export function getDesiredLabels(config: Config): LabelSpec[] {
  const allNames = new Set<string>();
  const families: string[][] = [config.priorityLabels, config.statusLabels, config.componentLabels];
  const familyNames = ['priorityLabels', 'statusLabels', 'componentLabels'];

  for (let i = 0; i < families.length; i++) {
    for (const name of families[i]) {
      if (allNames.has(name)) {
        throw new Error(`Duplicate label name '${name}' appears in both ${familyNames[i]} and another family. Fix aie.config.json.`);
      }
      allNames.add(name);
    }
  }

  const result: LabelSpec[] = [];
  for (const name of allNames) {
    const spec = DEFAULT_LABEL_SPECS[name];
    if (spec) {
      result.push({ name, ...spec });
    } else {
      result.push({ name, color: DEFAULT_CUSTOM_COLOR, description: DEFAULT_CUSTOM_DESCRIPTION });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function computeLabelPlan(current: LabelSpec[], desired: LabelSpec[]): LabelPlan {
  const currentMap = new Map(current.map(l => [l.name, l]));
  const plan: LabelPlan = { created: [], updated: [], unchanged: [], skipped: [] };

  for (const d of desired) {
    const c = currentMap.get(d.name);
    if (!c) {
      plan.created.push({ ...d });
    } else if (c.color !== d.color || c.description !== d.description) {
      plan.updated.push({ ...d });
    } else {
      plan.unchanged.push({ ...d });
    }
  }

  for (const c of current) {
    if (!desired.some(d => d.name === c.name)) {
      plan.skipped.push({ ...c });
    }
  }

  return plan;
}

export async function applyLabelPlan(plan: LabelPlan, exec?: GhExec): Promise<void> {
  for (const label of plan.created) {
    await runGh(['label', 'create', label.name, '--color', label.color, '--description', label.description], { exec });
  }
  for (const label of plan.updated) {
    await runGh(['label', 'edit', label.name, '--color', label.color, '--description', label.description], { exec });
  }
}

interface RawGhLabel {
  name: string;
  color: string;
  description: string | null;
}

function isRawGhLabel(v: unknown): v is RawGhLabel {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === 'string' && typeof o.color === 'string';
}

function isRawGhLabelArray(v: unknown): v is RawGhLabel[] {
  return Array.isArray(v) && v.every(isRawGhLabel);
}

export function parseGhLabelList(stdout: string): Array<{name: string; color: string; description: string}> {
  const raw = parseGhJson<RawGhLabel[]>(stdout, 'gh label list', isRawGhLabelArray);
  return raw.map(r => ({
    name: r.name,
    color: r.color,
    description: r.description || '',
  }));
}
