import { serve } from "@hono/node-server";
import app from "./index.js";
import { renderMetrics } from "./metrics/index.js";

const port = Number(process.env.PORT ?? 8787);

// Node-only per SPEC §14: Workers isolates are ephemeral, so in-memory metrics
// there would be meaningless. Registered here, not in src/index.ts.
app.get("/metrics", (c) => c.text(renderMetrics(), 200, { "Content-Type": "text/plain; version=0.0.4" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`icegate listening on http://localhost:${info.port}`);
});
