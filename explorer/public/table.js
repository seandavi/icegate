// Table detail view: Overview / Schema / History / Query tabs from a single
// LoadTableResult fetch. Catalog-agnostic — no cancer-on-ice-specific
// properties or business-key logic (see CONTRACT.md). Ported from
// cancer-on-ice's explorer/public/app.js (renderTable/renderSnapshots).
import { makeApi, escapeHtml, sectionTitle, sqlBlock, fmtType, fmtTs, status, attachSql, nsPath, nsLabel } from "./util.js";

// `ns` is the REST API's array of namespace parts (a single-level namespace is
// a one-element array); everything below goes through nsPath/nsLabel/sqlIdent
// rather than assuming it is a plain string.
export async function renderTableDetail(container, catalog, ns, table) {
  const nsName = nsLabel(ns);
  container.innerHTML = "";
  container.appendChild(status(`Loading ${nsName}.${table}…`, true));

  const api = makeApi(catalog);
  let data;
  try {
    data = await api(`/namespaces/${nsPath(ns)}/tables/${encodeURIComponent(table)}`);
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(status(`Could not load this table: ${err.message}`));
    return;
  }

  const meta = data.metadata || {};
  const schema =
    (meta.schemas || []).find((s) => s["schema-id"] === meta["current-schema-id"]) ||
    meta.schemas?.[0] || { fields: [] };
  const props = meta.properties || {};
  const keyIds = new Set(schema["identifier-field-ids"] || []);

  container.innerHTML = "";

  const h2 = document.createElement("h2");
  h2.textContent = `${nsName}.${table}`;
  container.appendChild(h2);

  const commentP = document.createElement("p");
  commentP.className = "muted";
  commentP.textContent = props.comment || "(no table comment)";
  container.appendChild(commentP);

  const tabDefs = [
    ["overview", "Overview"],
    ["schema", "Schema"],
    ["history", "History"],
    ["query", "Query"],
  ];
  const tabsNav = document.createElement("div");
  tabsNav.className = "tabs";
  tabsNav.setAttribute("role", "tablist");
  const panels = {};
  for (const [id, label] of tabDefs) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", id === "overview" ? "true" : "false");
    b.addEventListener("click", () => {
      for (const c of tabsNav.children) c.setAttribute("aria-selected", "false");
      b.setAttribute("aria-selected", "true");
      for (const k in panels) panels[k].hidden = k !== id;
      if (id === "query") mountQueryPanel();
    });
    tabsNav.appendChild(b);
  }
  container.appendChild(tabsNav);

  panels.overview = renderOverview(catalog, ns, table, meta, schema, props);
  container.appendChild(panels.overview);

  panels.schema = renderSchema(catalog, ns, table, schema, keyIds);
  panels.schema.hidden = true;
  container.appendChild(panels.schema);

  panels.history = renderHistory(meta);
  panels.history.hidden = true;
  container.appendChild(panels.history);

  panels.query = document.createElement("div");
  panels.query.hidden = true;
  container.appendChild(panels.query);

  let queryMounted = false;
  async function mountQueryPanel() {
    if (queryMounted) return;
    queryMounted = true;
    panels.query.appendChild(status("Loading query engine…", true));
    try {
      const { buildQueryPanel } = await import("./duck.js");
      panels.query.innerHTML = "";
      panels.query.appendChild(buildQueryPanel(catalog, ns, table));
    } catch (err) {
      panels.query.innerHTML = "";
      const p = document.createElement("p");
      p.className = "warn";
      p.textContent = `Could not load the query engine: ${err.message || err}`;
      panels.query.appendChild(p);
    }
  }
}

// ---------- Overview ----------

function renderOverview(catalog, ns, table, meta, schema, props) {
  const el = document.createElement("div");
  el.appendChild(sectionTitle("Copyable DuckDB snippet"));
  el.appendChild(sqlBlock(attachSql(catalog, ns, table)));

  const partSpec = (meta["partition-specs"] || []).find((p) => p["spec-id"] === meta["default-spec-id"]);
  if (partSpec?.fields?.length) {
    el.appendChild(sectionTitle("Partitioned by"));
    const p = document.createElement("p");
    p.textContent = partSpec.fields.map((f) => `${f.name} (${f.transform})`).join(", ");
    el.appendChild(p);
  }

  const sortOrder = (meta["sort-orders"] || []).find((s) => s["order-id"] === meta["default-sort-order-id"]);
  if (sortOrder?.fields?.length) {
    // sort-order fields carry source-id, not a name — unlike partition-spec fields.
    const idToName = Object.fromEntries((schema.fields || []).map((f) => [f.id, f.name]));
    el.appendChild(sectionTitle("Sort order"));
    const p = document.createElement("p");
    p.textContent = sortOrder.fields
      .map((f) => `${idToName[f["source-id"]] ?? f["source-id"]} ${f.transform} ${f.direction}`)
      .join(", ");
    el.appendChild(p);
  }

  const cur = (meta.snapshots || []).find((s) => s["snapshot-id"] === meta["current-snapshot-id"]);
  const sum = cur?.summary || {};
  el.appendChild(sectionTitle("Table"));
  el.appendChild(
    kvTable([
      ["location", meta.location || "–"],
      ["format-version", meta["format-version"] ?? "–"],
      ["current-snapshot-id", meta["current-snapshot-id"] ?? "–"],
      ["current-snapshot-timestamp", cur ? fmtTs(cur["timestamp-ms"]) : "–"],
      ["total-records", sum["total-records"] ?? "–"],
      ["total-data-files", sum["total-data-files"] ?? "–"],
      // spec field is `total-files-size`; tolerate the alternate name too.
      ["total-size", humanizeBytes(sum["total-files-size"] ?? sum["total-file-size-in-bytes"])],
    ])
  );

  const propEntries = Object.entries(props).filter(([k]) => k !== "comment");
  if (propEntries.length) {
    el.appendChild(sectionTitle("Properties"));
    el.appendChild(kvTable(propEntries));
  }

  return el;
}

function humanizeBytes(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function kvTable(pairs) {
  const t = document.createElement("table");
  t.className = "cols";
  const tbody = document.createElement("tbody");
  for (const [k, v] of pairs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><code>${escapeHtml(k)}</code></td><td>${escapeHtml(String(v))}</td>`;
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

// ---------- Schema ----------

function renderSchema(catalog, ns, table, schema, keyIds) {
  const el = document.createElement("div");
  const t = document.createElement("table");
  t.className = "cols";
  t.innerHTML = `<thead><tr><th>Column</th><th>Type</th><th>Required</th><th>Key</th><th>Doc</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const f of schema.fields || []) {
    const tr = document.createElement("tr");
    tr.dataset.col = f.name;
    tr.innerHTML = `
      <td><code>${escapeHtml(f.name)}</code></td>
      <td><code>${escapeHtml(fmtType(f.type))}</code></td>
      <td>${f.required ? "yes" : "no"}</td>
      <td>${keyIds.has(f.id) ? '<span class="badge key">key</span>' : "&nbsp;"}</td>
      <td>${escapeHtml(f.doc || "")}</td>`;
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  const wrap = document.createElement("div");
  wrap.className = "scroll-x";
  wrap.appendChild(t);
  el.appendChild(wrap);

  const analyzeBtn = document.createElement("button");
  analyzeBtn.type = "button";
  analyzeBtn.className = "copy-btn";
  analyzeBtn.style.position = "static"; // .copy-btn is normally absolutely positioned inside .copy-wrap
  analyzeBtn.style.marginTop = "0.75rem";
  analyzeBtn.textContent = "Analyze";
  el.appendChild(analyzeBtn);

  const analyzeStatus = document.createElement("div");
  el.appendChild(analyzeStatus);

  analyzeBtn.addEventListener("click", async () => {
    analyzeBtn.disabled = true;
    analyzeStatus.innerHTML = "";
    analyzeStatus.appendChild(status("Analyzing…", true));
    try {
      const { columnStats } = await import("./duck.js");
      const { rows } = await columnStats(catalog, ns, table);
      analyzeStatus.innerHTML = "";
      addStatsColumns(t, rows);
    } catch (err) {
      analyzeStatus.innerHTML = "";
      const p = document.createElement("p");
      p.className = "warn";
      p.textContent = `Could not analyze columns: ${err.message || err} (a browser-to-object-storage CORS failure is expected for some catalogs).`;
      analyzeStatus.appendChild(p);
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  return el;
}

function addStatsColumns(t, statRows) {
  const byName = new Map((statRows || []).map((r) => [r.column_name, r]));
  const headRow = t.querySelector("thead tr");
  for (const label of ["Null %", "Distinct", "Min", "Max", "P25", "P50", "P75"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  for (const tr of t.querySelectorAll("tbody tr")) {
    const s = byName.get(tr.dataset.col);
    const vals = s
      ? [s.null_percentage, s.approx_unique, s.min, s.max, s.q25, s.q50, s.q75]
      : [null, null, null, null, null, null, null];
    vals.forEach((v, i) => {
      const td = document.createElement("td");
      // min/max (2, 3) can be any type; the rest are always numeric.
      if (i !== 2 && i !== 3) td.className = "num";
      td.textContent = v ?? "–";
      tr.appendChild(td);
    });
  }
}

// ---------- History ----------

function renderHistory(meta) {
  const el = document.createElement("div");
  const byId = new Map((meta.snapshots || []).map((s) => [s["snapshot-id"], s]));
  // snapshot-log is the authoritative commit sequence (what was actually HEAD,
  // e.g. excludes other-branch snapshots retained in `snapshots`); fall back
  // to `snapshots` itself for a table with no log.
  const log = meta["snapshot-log"] || meta.snapshots || [];
  const seen = new Set();
  const rows = [];
  for (const entry of log) {
    const id = entry["snapshot-id"];
    if (seen.has(id)) continue; // ponytail: snapshot-log can repeat an id across rollbacks
    seen.add(id);
    const snap = byId.get(id) || entry;
    rows.push({ id, ts: snap["timestamp-ms"] ?? entry["timestamp-ms"] ?? 0, snap });
  }
  rows.sort((a, b) => b.ts - a.ts);

  if (!rows.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No snapshots.";
    el.appendChild(p);
    return el;
  }

  const SHOWN = 100;
  const wrap = document.createElement("div");
  wrap.className = "scroll-x";
  const t = document.createElement("table");
  t.className = "snap-table";
  t.innerHTML =
    "<thead><tr><th>Timestamp (UTC)</th><th>Operation</th><th>+records</th><th>-records</th>" +
    "<th>+files</th><th>-files</th><th>Total records</th><th>Snapshot id</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const { id, ts, snap } of rows.slice(0, SHOWN)) {
    const sum = snap.summary || {};
    const isCurrent = id === meta["current-snapshot-id"];
    const tr = document.createElement("tr");
    if (isCurrent) tr.className = "current";
    if (snap["parent-snapshot-id"] != null) tr.title = `parent: ${snap["parent-snapshot-id"]}`;
    tr.innerHTML = `
      <td>${ts ? escapeHtml(fmtTs(ts)) : "–"}</td>
      <td>${escapeHtml(sum.operation || "–")}${isCurrent ? " (current)" : ""}</td>
      <td class="num">${sum["added-records"] ?? "–"}</td>
      <td class="num">${sum["deleted-records"] ?? "–"}</td>
      <td class="num">${sum["added-data-files"] ?? "–"}</td>
      <td class="num">${sum["deleted-data-files"] ?? "–"}</td>
      <td class="num">${sum["total-records"] ?? "–"}</td>
      <td><code>${escapeHtml(String(id))}</code></td>`;
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  el.appendChild(wrap);

  if (rows.length > SHOWN) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = `Showing the latest ${SHOWN} of ${rows.length} snapshots.`;
    el.appendChild(p);
  }

  return el;
}
