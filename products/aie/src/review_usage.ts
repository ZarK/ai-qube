export interface LaneUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Host envelopes use several token-field aliases. Only recognized numeric
// fields are kept; missing or malformed usage is omitted rather than coerced
// to zero so a silent "0 tokens" never looks like a real report.
export function readHostUsage(value: unknown): LaneUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = readNonNegativeNumber(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
  const outputTokens = readNonNegativeNumber(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  const cachedInputTokens = readNonNegativeNumber(value.cachedInputTokens ?? value.cached_input_tokens);
  const totalTokens = readNonNegativeNumber(value.totalTokens ?? value.total_tokens);
  const cost = readNonNegativeNumber(value.cost ?? value.total_cost);
  const currency = typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) ? value.currency : undefined;
  const usage: LaneUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (cost !== undefined) usage.cost = cost;
  if (currency !== undefined) usage.currency = currency;
  return Object.keys(usage).length > 0 ? usage : undefined;
}
