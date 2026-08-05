import type { Context, Next } from "hono";

// ponytail: hand-rolled Prometheus text format, no client library — the format is a few lines.
const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const requestsTotal = new Map<string, number>(); // key: `${method}|${status}`
const backendErrorsTotal = new Map<string, number>(); // key: backend
let authFailuresTotal = 0;
let activeRequests = 0;
const durationBucketCounts = new Array(buckets.length).fill(0);
let durationSum = 0;
let durationCount = 0;

function inc(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Shared middleware — harmless on Workers, where /metrics itself is not exposed. */
export async function metricsMiddleware(c: Context, next: Next) {
  activeRequests++;
  const start = performance.now();
  try {
    await next();
  } finally {
    activeRequests--;
    const durationSeconds = (performance.now() - start) / 1000;
    durationSum += durationSeconds;
    durationCount++;
    for (let i = 0; i < buckets.length; i++) {
      if (durationSeconds <= buckets[i]) durationBucketCounts[i]++;
    }

    const status = c.res.status;
    inc(requestsTotal, `${c.req.method}|${status}`);
    if (status === 401 || status === 403) authFailuresTotal++;

    const backend = c.get("backend") as string | null | undefined;
    if (backend && status >= 500) inc(backendErrorsTotal, backend);
  }
}

export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP requests_total Total number of requests processed.");
  lines.push("# TYPE requests_total counter");
  for (const [key, count] of requestsTotal) {
    const [method, status] = key.split("|");
    lines.push(`requests_total{method="${method}",status="${status}"} ${count}`);
  }

  lines.push("# HELP request_duration_seconds Request latency in seconds.");
  lines.push("# TYPE request_duration_seconds histogram");
  for (let i = 0; i < buckets.length; i++) {
    lines.push(`request_duration_seconds_bucket{le="${buckets[i]}"} ${durationBucketCounts[i]}`);
  }
  lines.push(`request_duration_seconds_bucket{le="+Inf"} ${durationCount}`);
  lines.push(`request_duration_seconds_sum ${durationSum}`);
  lines.push(`request_duration_seconds_count ${durationCount}`);

  lines.push("# HELP backend_errors_total Total backend error responses (5xx), by backend.");
  lines.push("# TYPE backend_errors_total counter");
  for (const [backend, count] of backendErrorsTotal) {
    lines.push(`backend_errors_total{backend="${backend}"} ${count}`);
  }

  lines.push("# HELP auth_failures_total Total authentication/authorization failures (401/403).");
  lines.push("# TYPE auth_failures_total counter");
  lines.push(`auth_failures_total ${authFailuresTotal}`);

  lines.push("# HELP active_requests Requests currently in flight.");
  lines.push("# TYPE active_requests gauge");
  lines.push(`active_requests ${activeRequests}`);

  return lines.join("\n") + "\n";
}
