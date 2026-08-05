import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

// Own file on purpose: src/index.ts memoizes config on the first gateway
// request, so any test calling useConfig() would pre-empt the bundled
// config.yaml this asserts on.
describe("the app's bundled config", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads config.yaml on the first gateway request and routes with it", async () => {
    const res = await app.request("/v1/config?warehouse=omicidx");

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://catalog.example.invalid/dev-account/omicidx/v1/config?warehouse=dev-account_omicidx",
    );
  });
});
