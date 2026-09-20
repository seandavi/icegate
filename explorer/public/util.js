// Shared helpers for the icegate explorer. Every other module imports these
// instead of re-implementing them (see CONTRACT.md).

// icegate rate-limits bursts of catalog calls, and loading a whole namespace
// tree up front is exactly that kind of burst, so a 429 gets one short retry
// before it's treated as a real error.
export function makeApi(catalog) {
  return async function api(path, { retried = false } = {}) {
    const res = await fetch(`${catalog.endpoint}/v1/${catalog.warehouse}${path}`);
    if (res.status === 429 && !retried) {
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      return api(path, { retried: true });
    }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return parseJson(await res.text());
  };
}

// Iceberg snapshot ids are int64, well past Number.MAX_SAFE_INTEGER, and
// JSON.parse silently rounds them: 4875483276225980728 comes back as
// 4875483276225980000. Displaying a rounded id is worse than useless — it
// names a snapshot that does not exist — so any integer long enough to be at
// risk is quoted before parsing and handled as a string from there on.
// Comparisons still work because every id goes through this same path.
// ponytail: a blunt lexical rule, not a JSON parser. 16+ digit integers in the
// Iceberg REST payloads we read are only ever ids; revisit if that changes.
export function parseJson(text) {
  return JSON.parse(text.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, ': "$1"'));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function sectionTitle(text) {
  const h3 = document.createElement("h3");
  h3.textContent = text;
  h3.style.marginBottom = "0.3rem";
  return h3;
}

export function sqlBlock(sql) {
  const wrap = document.createElement("div");
  wrap.className = "copy-wrap";
  const pre = document.createElement("pre");
  pre.className = "sql";
  pre.textContent = sql;
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.type = "button";
  btn.textContent = "Copy";
  btn.addEventListener("click", () => copyText(sql, btn));
  wrap.appendChild(pre);
  wrap.appendChild(btn);
  return wrap;
}

export function copyText(text, btn) {
  const done = () => {
    const orig = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = orig), 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch { /* ponytail: best-effort fallback for clipboard API-less browsers */ }
  document.body.removeChild(ta);
  done();
}

// A namespace arrives either as the REST API's array of parts or as a
// dot-joined display string; every consumer needs one of three forms of it.
function nsParts(ns) {
  return Array.isArray(ns) ? ns : String(ns).split(".");
}

// REST path segment: the Iceberg REST spec joins multi-level namespace parts
// with the unit separator (0x1F), each part URI-encoded.
export function nsPath(ns) {
  return nsParts(ns).map(encodeURIComponent).join("\u001f");
}

export function nsLabel(ns) {
  return nsParts(ns).join(".");
}

// Fully-qualified SQL identifier, each part quoted separately — a multi-level
// namespace is several identifiers, not one with a dot in it.
export function sqlIdent(ns, table) {
  return [...nsParts(ns), table].map((s) => `"${String(s).replace(/"/g, '""')}"`).join(".");
}

export function fmtType(t) {
  if (typeof t === "string") return t;
  if (t?.type === "list") return `list<${fmtType(t.element)}>`;
  if (t?.type === "struct") return "struct";
  if (t?.type === "map") return `map<${fmtType(t.key)}, ${fmtType(t.value)}>`;
  return JSON.stringify(t);
}

export function fmtTs(ms) {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function status(text, busy = false) {
  const p = document.createElement("p");
  p.className = "status";
  if (busy) p.setAttribute("aria-busy", "true");
  p.textContent = text;
  return p;
}

export function attachSql(catalog, ns, table) {
  return [
    "INSTALL iceberg; LOAD iceberg;",
    `ATTACH '${catalog.warehouse}' AS cat (TYPE ICEBERG, ENDPOINT '${catalog.endpoint}', AUTHORIZATION_TYPE 'none');`,
    "",
    `SELECT * FROM cat.${sqlIdent(ns, table)} LIMIT 10;`,
  ].join("\n");
}
