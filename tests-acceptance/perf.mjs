// SPEC §19 performance: 100 concurrent requests must all succeed, and the
// gateway's median added latency must stay under the target.
//
//   node perf.mjs <gateway-url> <backend-url>
//
// Both URLs must return the same logical resource so the medians are
// comparable (the gateway path and the backend path it proxies to).
const [gateway, backend] = process.argv.slice(2);
const CONCURRENCY = 100;
const SAMPLES = 50;
const TARGET_MS = 10;

let failed = false;
const pass = (name) => console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
const fail = (name, detail) => {
  console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${detail}`);
  failed = true;
};

async function timed(url) {
  const start = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  return { ms: performance.now() - start, status: response.status };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => timed(gateway)));
const bad = results.filter((r) => r.status !== 200);
if (bad.length === 0) {
  pass(`${CONCURRENCY} concurrent requests, no failures (median ${median(results.map((r) => r.ms)).toFixed(1)}ms)`);
} else {
  fail(`${CONCURRENCY} concurrent requests`, `${bad.length} non-200: ${[...new Set(bad.map((r) => r.status))]}`);
}

// Interleaved so drift in the backend or the machine hits both series equally.
const gatewayMs = [];
const backendMs = [];
for (let i = 0; i < SAMPLES + 10; i++) {
  const g = await timed(gateway);
  const b = await timed(backend);
  if (i < 10) continue; // warm-up
  gatewayMs.push(g.ms);
  backendMs.push(b.ms);
}

const overhead = median(gatewayMs) - median(backendMs);
const detail =
  `median gateway ${median(gatewayMs).toFixed(2)}ms vs direct ${median(backendMs).toFixed(2)}ms ` +
  `= ${overhead.toFixed(2)}ms overhead (target <${TARGET_MS}ms, n=${SAMPLES})`;
if (overhead < TARGET_MS) pass(detail);
else fail("gateway overhead over target", detail);

process.exit(failed ? 1 : 0);
