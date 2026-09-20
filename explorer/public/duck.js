// In-browser DuckDB-WASM: per-catalog connection, SUMMARIZE-based column
// stats, and the read-only query panel. Ported from cancer-on-ice's
// getDuckDB/buildQueryPanel/renderResultTable, generalized to any catalog.
// Nothing here touches the network at import time — only when a function
// below is actually called.
import { escapeHtml, sqlIdent } from "./util.js";

const DUCKDB_WASM_URL = "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-browser.mjs";

// Singleton connection per catalog.id.
const connPromises = new Map();

export async function getConn(catalog) {
  if (!connPromises.has(catalog.id)) {
    connPromises.set(catalog.id, connectTo(catalog));
  }
  return connPromises.get(catalog.id);
}

async function connectTo(catalog) {
  const duckdb = await import(DUCKDB_WASM_URL);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  const conn = await db.connect();
  await conn.query("INSTALL iceberg; LOAD iceberg; INSTALL httpfs; LOAD httpfs;");
  await conn.query(
    `ATTACH '${catalog.warehouse}' AS cat (TYPE ICEBERG, ENDPOINT '${catalog.endpoint}', AUTHORIZATION_TYPE 'none');`
  );
  return conn;
}

// The attached alias is always `cat`; sqlIdent quotes each namespace part and
// the table name separately.
function qualifiedName(ns, table) {
  return `cat.${sqlIdent(ns, table)}`;
}

// SUMMARIZE returns Arrow rows; BigInt fields (count, approx_unique, …)
// can't be JSON.stringify'd, so stringify them here for display.
function sanitizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

export async function columnStats(catalog, ns, table, sampleRows = 100000) {
  const conn = await getConn(catalog);
  const res = await conn.query(
    `SUMMARIZE SELECT * FROM ${qualifiedName(ns, table)} LIMIT ${sampleRows};`
  );
  const rows = res.toArray().map((r) => sanitizeRow(r.toJSON()));
  // ponytail: SUMMARIZE's "count" is the non-null count per column, not a
  // single "rows scanned" total — take the max across columns as an
  // approximation (good enough since at least one column is usually fully
  // populated); a second COUNT(*) query would give an exact figure.
  const rowsScanned = rows.reduce((m, r) => Math.max(m, Number(r.count) || 0), 0);
  return { rowsScanned, rows };
}

// ---------- query panel ----------

const WRITE_STATEMENT = /^\s*(insert|update|delete|merge|attach|detach|copy|pragma|create|drop|alter|call|export|import|install|load|set|vacuum)\b/i;
const ROW_CAP = 1000;

export function buildQueryPanel(catalog, ns, table) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<p class="muted">Runs in-browser via DuckDB-WASM, reading table data straight from the
    object store through icegate — no credentials, nothing sent to any server but Cloudflare's edge.</p>`;

  const box = document.createElement("textarea");
  box.id = "sql-box";
  box.setAttribute("aria-label", "SQL query");
  box.value = `SELECT * FROM ${qualifiedName(ns, table)} LIMIT 25;`;
  wrap.appendChild(box);

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.gap = "0.75rem";
  controls.style.alignItems = "center";
  controls.style.margin = "0.5rem 0";

  const runBtn = document.createElement("button");
  runBtn.className = "copy-btn";
  // ponytail: .copy-btn is `position: absolute` (meant for the Copy icon in a
  // .copy-wrap); override so it sits inline in this plain flex toolbar.
  runBtn.style.position = "static";
  runBtn.type = "button";
  runBtn.textContent = "Run";
  controls.appendChild(runBtn);
  wrap.appendChild(controls);

  const out = document.createElement("div");
  out.setAttribute("role", "status");
  wrap.appendChild(out);

  runBtn.addEventListener("click", async () => {
    const raw = box.value.trim();
    const isMultiStatement = raw.includes(";") && raw.split(";").filter((s) => s.trim()).length > 1;
    if (WRITE_STATEMENT.test(raw) || isMultiStatement) {
      out.innerHTML = `<p class="warn">Refused: this box only runs a single read-only SELECT/WITH.</p>`;
      return;
    }
    const sql = `SELECT * FROM (${raw.replace(/;\s*$/, "")}) t LIMIT ${ROW_CAP}`;
    out.innerHTML = `<p class="status" aria-busy="true">Running…</p>`;
    try {
      const conn = await getConn(catalog);
      const t0 = performance.now();
      const res = await conn.query(sql);
      const ms = Math.round(performance.now() - t0);
      const rows = res.toArray().map((r) => sanitizeRow(r.toJSON()));
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `${rows.length} row(s) in ${ms} ms${rows.length === ROW_CAP ? ` (capped at ${ROW_CAP})` : ""}`;
      out.appendChild(p);
      const scroll = document.createElement("div");
      scroll.className = "scroll-x";
      scroll.appendChild(renderResultTable(rows));
      out.appendChild(scroll);
    } catch (err) {
      out.innerHTML = `<p class="warn">${escapeHtml(err.message || String(err))}</p>`;
    }
  });

  return wrap;
}

function renderResultTable(rows) {
  const t = document.createElement("table");
  t.className = "cols";
  if (!rows.length) {
    t.innerHTML = "<tbody><tr><td>(no rows)</td></tr></tbody>";
    return t;
  }
  const cols = Object.keys(rows[0]);
  t.innerHTML = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = cols.map((c) => `<td>${escapeHtml(String(r[c]))}</td>`).join("");
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}
