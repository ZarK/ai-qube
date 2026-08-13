export const DEFAULT_LIVE_MAX_REQUESTS = 100;
export const DEFAULT_LIVE_TIMEOUT_MS = 90_000;

export class RequestBudgetExceededError extends Error {
  readonly requestCount: number;
  readonly maxRequests: number;

  constructor(requestCount: number, maxRequests: number) {
    super(`Live suite exceeded the request budget (${requestCount}/${maxRequests}).`);
    this.name = "RequestBudgetExceededError";
    this.requestCount = requestCount;
    this.maxRequests = maxRequests;
  }
}

export class RequestBudget {
  readonly maxRequests: number;
  readonly timeoutMs: number;
  private count = 0;

  constructor(options: { readonly maxRequests?: number; readonly timeoutMs?: number } = {}) {
    this.maxRequests = positiveInteger(options.maxRequests ?? DEFAULT_LIVE_MAX_REQUESTS, "maxRequests");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS, "timeoutMs");
  }

  get requestCount(): number {
    return this.count;
  }

  consume(label = "request"): void {
    this.count += 1;
    if (this.count > this.maxRequests) {
      throw new RequestBudgetExceededError(this.count, this.maxRequests);
    }
    void label;
  }

  wrapFetch(fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      this.consume("http");
      return fetchImpl(input, init);
    };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Live suite ${name} must be a positive integer.`);
  }
  return value;
}
