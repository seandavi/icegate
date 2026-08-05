import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { metricsMiddleware, renderMetrics } from "../src/metrics/index";

describe("metrics", () => {
  it("counts requests and reports sane histogram buckets after a request", async () => {
    await app.request("/health");

    const text = renderMetrics();

    expect(text).toMatch(/requests_total\{method="GET",status="200"\} \d+/);
    expect(text).toContain("# TYPE request_duration_seconds histogram");
    expect(text).toMatch(/request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
    expect(text).toMatch(/request_duration_seconds_count \d+/);
    expect(text).toContain("# TYPE backend_errors_total counter");
    expect(text).toMatch(/auth_failures_total \d+/);
    expect(text).toMatch(/active_requests \d+/);

    // Bucket counts must be non-decreasing (cumulative "le" semantics) and
    // the +Inf bucket must equal the total observation count.
    const bucketCounts = [...text.matchAll(/_bucket\{le="[^"]+"\} (\d+)/g)].map((m) => Number(m[1]));
    for (let i = 1; i < bucketCounts.length; i++) {
      expect(bucketCounts[i]).toBeGreaterThanOrEqual(bucketCounts[i - 1]);
    }
    const countMatch = text.match(/request_duration_seconds_count (\d+)/);
    expect(countMatch).not.toBeNull();
    expect(bucketCounts[bucketCounts.length - 1]).toBe(Number(countMatch![1]));
  });

  it("counts auth failures for 401/403 responses", async () => {
    const before = Number(renderMetrics().match(/auth_failures_total (\d+)/)![1]);

    const probeApp = new Hono();
    probeApp.use("*", metricsMiddleware);
    probeApp.get("/denied", (c) => c.json({ error: "unauthorized" }, 401));
    await probeApp.request("/denied");

    const after = Number(renderMetrics().match(/auth_failures_total (\d+)/)![1]);
    expect(after).toBe(before + 1);
  });
});
