import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

describe("request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits one structured JSON line per request", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await app.request("/health");

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({
      principal: null,
      namespace: null,
      backend: null,
      status: 200,
    });
    expect(typeof line.timestamp).toBe("string");
    expect(new Date(line.timestamp).toISOString()).toBe(line.timestamp);
    expect(typeof line.requestId).toBe("string");
    expect(typeof line.latencyMs).toBe("number");
  });

  it("honors an incoming x-request-id header", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await app.request("/health", { headers: { "x-request-id": "test-request-id" } });

    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.requestId).toBe("test-request-id");
  });

  it("generates a request id when none is supplied", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await app.request("/health");

    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line.requestId.length).toBeGreaterThan(0);
  });
});
