import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config/index.js";
import app, { useConfig } from "./index.js";
import { renderMetrics } from "./metrics/index.js";

const port = Number(process.env.PORT ?? 8787);

// Workers gets the same file bundled as a text module; Node reads it here so
// core never touches node:fs or process.env.
const configPath = join(dirname(fileURLToPath(import.meta.url)), "../config.yaml");
useConfig(loadConfig(readFileSync(configPath, "utf8"), process.env));

// Node-only per SPEC §14: Workers isolates are ephemeral, so in-memory metrics
// there would be meaningless. Registered here, not in src/index.ts.
app.get("/metrics", (c) => c.text(renderMetrics(), 200, { "Content-Type": "text/plain; version=0.0.4" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`icegate listening on http://localhost:${info.port}`);
});
