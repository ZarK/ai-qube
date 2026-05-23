export type ChecklistState = 'checked' | 'unchecked';

export interface ChecklistItem {
  index: number;
  line: number;
  text: string;
  checked: boolean;
}

export interface ChecklistSummary {
  total: number;
  checked: number;
  unchecked: number;
  items: ChecklistItem[];
}

export interface ChecklistSelector {
  index?: number;
  text?: string;
}

export interface ChecklistUpdatePlan {
  updatedBody: string;
  matchedItems: ChecklistItem[];
  before: ChecklistSummary;
  after: ChecklistSummary;
  changed: boolean;
}

const CHECKLIST_LINE = /^(\s*(?:[-*+]\s+)?)\[([ xX])\](\s+)(.*)$/;

function stateToken(state: ChecklistState): string {
  return state === 'checked' ? 'x' : ' ';
}

function parseSelector(selector: ChecklistSelector): ChecklistSelector {
  const hasIndex = selector.index !== undefined;
  const text = selector.text?.trim();
  const hasText = text !== undefined && text !== '';
  if (hasIndex && hasText) {
    throw new Error('plan checklist update failed. Likely cause: both index and item text were provided. Next action: provide exactly one selector.');
  }
  if (!hasIndex && !hasText) {
    throw new Error('plan checklist update failed. Likely cause: no checklist selector was provided. Next action: pass --index <n> or --item <text>.');
  }
  if (hasIndex) {
    const index = selector.index;
    if (!Number.isInteger(index) || index === undefined || index <= 0) {
      throw new Error('plan checklist update failed. Likely cause: checklist index must be a positive integer. Next action: pass a 1-based checklist index.');
    }
    return { index };
  }
  return { text };
}

export function parseChecklist(body: string): ChecklistSummary {
  const items: ChecklistItem[] = [];
  for (const [lineIndex, line] of body.split(/\r?\n/).entries()) {
    const match = line.match(CHECKLIST_LINE);
    if (match) {
      items.push({
        index: items.length + 1,
        line: lineIndex + 1,
        text: match[4].trim(),
        checked: match[2].toLowerCase() === 'x',
      });
    }
  }
  const checked = items.filter(item => item.checked).length;
  return { total: items.length, checked, unchecked: items.length - checked, items };
}

function selectChecklistItems(summary: ChecklistSummary, selector: ChecklistSelector): ChecklistItem[] {
  const parsed = parseSelector(selector);
  if (parsed.index !== undefined) {
    const selectedIndex = parsed.index;
    const match = summary.items.find(item => item.index === selectedIndex);
    if (!match) {
      throw new Error(`plan checklist update failed. Likely cause: checklist item #${selectedIndex} does not exist. Next action: run \`aie view <issue> --json\` and choose an existing checklist index.`);
    }
    return [match];
  }
  const matches = summary.items.filter(item => item.text === parsed.text);
  if (matches.length === 0) {
    throw new Error(`plan checklist update failed. Likely cause: no checklist item matched "${parsed.text}". Next action: run \`aie view <issue>\` and pass the exact checklist item text or use --index.`);
  }
  if (matches.length > 1) {
    throw new Error(`plan checklist update failed. Likely cause: checklist item text "${parsed.text}" matched multiple items: ${matches.map(item => `#${item.index}`).join(', ')}. Next action: rerun with --index.`);
  }
  return matches;
}

export function planChecklistUpdate(body: string, selector: ChecklistSelector, state: ChecklistState): ChecklistUpdatePlan {
  const before = parseChecklist(body);
  const matchedItems = selectChecklistItems(before, selector);
  const targetIndexes = new Set(matchedItems.map(item => item.index));
  let checklistIndex = 0;
  let changed = false;
  const lines = body.split(/\r?\n/).map(line => {
    const match = line.match(CHECKLIST_LINE);
    if (!match) return line;
    checklistIndex += 1;
    if (!targetIndexes.has(checklistIndex)) return line;
    if ((match[2].toLowerCase() === 'x') === (state === 'checked')) return line;
    changed = true;
    return `${match[1]}[${stateToken(state)}]${match[3]}${match[4]}`;
  });
  const updatedBody = lines.join('\n');
  return { updatedBody, matchedItems, before, after: parseChecklist(updatedBody), changed };
}
