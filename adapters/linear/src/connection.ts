import {
  linearConnectionContract,
  runConnectionProbe,
  type ConnectionProbeOptions,
  type ConnectionProbeResult,
  type ConnectionHttpRequest,
  type ConnectionHttpResponse,
} from "@tjalve/qube-core";

export async function probeLinearConnection(options: ConnectionProbeOptions = {}): Promise<ConnectionProbeResult> {
  return runConnectionProbe(linearConnectionContract, {
    ...options,
    env: options.env ?? process.env,
    fetch: options.fetch ?? fetchConnection,
  });
}

async function fetchConnection(request: ConnectionHttpRequest): Promise<ConnectionHttpResponse> {
  const headers: Record<string, string> = { ...request.headers };
  if (request.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${request.basicAuth.username}:${request.basicAuth.password}`, "utf8").toString("base64")}`;
  const response = await fetch(request.url, { method: request.method, headers, ...(request.body === undefined ? {} : { body: request.body }), signal: AbortSignal.timeout(request.timeoutMs) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
