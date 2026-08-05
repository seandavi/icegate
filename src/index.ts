import { Hono } from "hono";
import { requestLogger } from "./logging/index.js";
import { metricsMiddleware } from "./metrics/index.js";

const app = new Hono();

app.use("*", metricsMiddleware);
app.use("*", requestLogger);

app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/ready", (c) => c.json({ status: "ready" }));

export default app;
