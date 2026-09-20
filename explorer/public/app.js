// icegate Explorer — multi-catalog shell: registry, URL-as-state routing,
// landing directory, header switcher, and the namespace -> table sidebar
// tree. Table rendering itself is delegated to table.js. Plain JS, no
// framework, no build step. Generalized from cancer-on-ice's explorer (#37).
import { makeApi, status, nsPath } from "./util.js";
import { renderTableDetail } from "./table.js";

const CUSTOM_KEY = "icegate_explorer_custom";
const NS_SEP = "\u001f"; // unit separator — joins multi-level namespace parts in the URL

// ---------- registry ----------

function loadCustomCatalogs() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return []; // ponytail: corrupt localStorage just means "no customs", not a crash
  }
}

function saveCustomCatalog(catalog) {
  const customs = loadCustomCatalogs().filter((c) => c.id !== catalog.id);
  customs.push(catalog);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customs));
}

function customCatalog(endpoint, warehouse) {
  endpoint = endpoint.replace(/\/+$/, "");
  return { id: `custom:${endpoint}/${warehouse}`, label: warehouse, endpoint, warehouse };
}

let registry = []; // registry catalogs + saved customs, populated on load

function findCatalog(id) {
  return registry.find((c) => c.id === id);
}

// ---------- URL-as-state ----------

function encodeNs(nsParts) {
  return nsParts.join(NS_SEP);
}
function decodeNs(nsParam) {
  return nsParam.split(NS_SEP);
}
function currentRoute() {
  const p = new URLSearchParams(location.search);
  const catalogId = p.get("catalog");
  const endpoint = p.get("endpoint");
  const warehouse = p.get("warehouse");
  const ns = p.get("ns");
  const table = p.get("table");
  let catalog = null;
  if (catalogId) catalog = findCatalog(catalogId);
  else if (endpoint && warehouse) catalog = customCatalog(endpoint, warehouse);
  return { catalog, ns: ns ? decodeNs(ns) : null, table: table || null };
}

function navigate(route) {
  const p = new URLSearchParams();
  if (route.catalog) {
    if (route.catalog.id.startsWith("custom:")) {
      p.set("endpoint", route.catalog.endpoint);
      p.set("warehouse", route.catalog.warehouse);
    } else {
      p.set("catalog", route.catalog.id);
    }
    if (route.ns) p.set("ns", encodeNs(route.ns));
    if (route.table) p.set("table", route.table);
  }
  const url = `${location.pathname}${p.toString() ? "?" + p.toString() : ""}`;
  history.pushState(null, "", url);
  render(currentRoute());
}

window.addEventListener("popstate", () => render(currentRoute()));

// ---------- header switcher ----------

const catalogSub = document.getElementById("catalog-sub");
const switcherEl = document.getElementById("switcher");

function renderSwitcher(activeCatalog) {
  switcherEl.innerHTML = "";

  const back = document.createElement("a");
  back.href = location.pathname;
  back.textContent = "Directory";
  back.addEventListener("click", (e) => {
    e.preventDefault();
    navigate({ catalog: null });
  });
  switcherEl.appendChild(back);

  const select = document.createElement("select");
  select.setAttribute("aria-label", "Catalog");
  const blank = document.createElement("option");
  blank.textContent = "Switch catalog…";
  blank.value = "";
  select.appendChild(blank);
  for (const c of registry) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.label;
    if (activeCatalog && c.id === activeCatalog.id) opt.selected = true;
    select.appendChild(opt);
  }
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom endpoint…";
  select.appendChild(customOpt);

  select.addEventListener("change", () => {
    if (select.value === "__custom__") {
      select.value = activeCatalog ? activeCatalog.id : "";
      showCustomForm();
      return;
    }
    const c = findCatalog(select.value);
    if (c) navigate({ catalog: c });
  });
  switcherEl.appendChild(select);

  if (activeCatalog) {
    catalogSub.textContent = `${activeCatalog.label} — ${activeCatalog.endpoint}`;
  } else {
    catalogSub.textContent = "";
  }
}

// ponytail: two prompt()s instead of a modal for the header's "Custom
// endpoint…" option — the directory page already has a real form for this;
// upgrade to a dialog if the header path gets used often enough to annoy.
function showCustomForm() {
  const endpoint = prompt("Catalog endpoint (no /v1 suffix):");
  if (!endpoint) return;
  const warehouse = prompt("Warehouse name:");
  if (!warehouse) return;
  const catalog = customCatalog(endpoint, warehouse);
  saveCustomCatalog(catalog);
  if (!findCatalog(catalog.id)) registry.push(catalog);
  navigate({ catalog });
}

// ---------- directory view ----------

const directoryMain = document.getElementById("directory-main");
const viewDirectory = document.getElementById("view-directory");
const viewBrowse = document.getElementById("view-browse");

async function renderDirectory() {
  directoryMain.hidden = false;
  viewBrowse.hidden = true;
  viewDirectory.innerHTML = "";

  const cards = document.createElement("div");
  cards.className = "cat-grid";
  viewDirectory.appendChild(cards);

  for (const catalog of registry) {
    // A button, not a div: the whole card is the click target, so it has to be
    // reachable and activatable from the keyboard.
    const card = document.createElement("button");
    card.type = "button";
    card.className = "cat-card";
    const h3 = document.createElement("h3");
    h3.textContent = catalog.label;
    card.appendChild(h3);
    if (catalog.description) {
      const desc = document.createElement("p");
      desc.className = "cat-desc";
      desc.textContent = catalog.description;
      card.appendChild(desc);
    }
    const endpointP = document.createElement("p");
    endpointP.className = "endpoint";
    endpointP.textContent = catalog.endpoint;
    card.appendChild(endpointP);
    const countsP = document.createElement("p");
    countsP.className = "counts";
    countsP.setAttribute("aria-busy", "true");
    countsP.textContent = "Loading…";
    card.appendChild(countsP);

    card.addEventListener("click", () => navigate({ catalog }));
    cards.appendChild(card);

    // Fire-and-forget per card: one unreachable catalog must not block others.
    catalogCounts(catalog)
      .then(({ namespaces, tables }) => {
        countsP.removeAttribute("aria-busy");
        countsP.textContent = `${namespaces} namespace(s), ${tables} table(s)`;
      })
      .catch((err) => {
        countsP.removeAttribute("aria-busy");
        countsP.textContent = `unreachable (${err.message})`;
      });
  }

  appendCustomForm(viewDirectory);
}

async function catalogCounts(catalog) {
  const api = makeApi(catalog);
  const { namespaces } = await api("/namespaces");
  const tableCounts = await Promise.all(
    namespaces.map((ns) =>
      api(`/namespaces/${nsPath(ns)}/tables`)
        .then((r) => r.identifiers.length)
        .catch(() => 0)
    )
  );
  return { namespaces: namespaces.length, tables: tableCounts.reduce((a, b) => a + b, 0) };
}

function appendCustomForm(container) {
  const form = document.createElement("form");
  form.className = "custom-endpoint-form";
  form.innerHTML = `
    <h3>Custom endpoint</h3>
    <label>Endpoint URL <input name="endpoint" type="url" placeholder="https://…" required></label>
    <label>Warehouse <input name="warehouse" type="text" required></label>
    <button type="submit">Browse</button>`;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const catalog = customCatalog(data.get("endpoint").trim(), data.get("warehouse").trim());
    saveCustomCatalog(catalog);
    if (!findCatalog(catalog.id)) registry.push(catalog);
    navigate({ catalog });
  });
  container.appendChild(form);
}

// ---------- browse view: sidebar tree ----------

const tree = document.getElementById("catalog-tree");

// ---------- sidebar filter ----------
// The tree is already in memory once loaded, so filtering it is a DOM loop,
// not a fetch. It is not URL state: it resets whenever the tree is rebuilt
// (catalog switch), same as the "no matches" line below.

const catalogNav = document.getElementById("catalog");
const treeLabel = document.createElement("h2");
treeLabel.className = "eyebrow";
treeLabel.textContent = "Namespaces";
catalogNav.insertBefore(treeLabel, catalogNav.firstChild);

const treeFilter = document.createElement("input");
treeFilter.type = "search";
treeFilter.className = "tree-filter";
treeFilter.setAttribute("aria-label", "Filter namespaces and tables");
treeFilter.placeholder = "Filter tables…";
catalogNav.insertBefore(treeFilter, treeLabel);

let currentNs = null; // ns/table of the current selection, for re-expanding
let currentTable = null; // it via highlight() once a filter is cleared
let noMatchEl = null;

function collapseAllGroups() {
  for (const group of tree.querySelectorAll(".ns-group")) {
    group.querySelector(".ns-button")?.setAttribute("aria-expanded", "false");
    const ul = group.querySelector("ul.tables");
    if (ul) ul.hidden = true;
  }
}

function setNoMatchMessage(term) {
  if (term === null) {
    noMatchEl?.remove();
    noMatchEl = null;
    return;
  }
  if (!noMatchEl) {
    noMatchEl = document.createElement("p");
    noMatchEl.className = "muted";
    tree.appendChild(noMatchEl);
  }
  noMatchEl.textContent = `No namespace or table matches \`${term}\``;
}

function applyFilter(rawTerm) {
  const term = rawTerm.trim();
  const q = term.toLowerCase();
  const groups = tree.querySelectorAll(".ns-group");

  if (!q) {
    for (const group of groups) {
      group.hidden = false;
      for (const li of group.querySelectorAll("ul.tables li")) li.hidden = false;
    }
    // ponytail: don't snapshot/restore each group's own prior expand state —
    // collapse everything and let highlight() reopen the selected group, the
    // same way it does on every render. Not worth the bookkeeping.
    collapseAllGroups();
    highlight(currentNs, currentTable);
    setNoMatchMessage(null);
    return;
  }

  let anyMatch = false;
  for (const group of groups) {
    const nsMatches = (group.dataset.nsLabel || "").toLowerCase().includes(q);
    const btn = group.querySelector(".ns-button");
    const ul = group.querySelector("ul.tables");
    let groupMatches = nsMatches;

    if (ul) {
      for (const li of ul.querySelectorAll("li")) {
        const tbtn = li.querySelector("button");
        const tableMatches = nsMatches || tbtn.dataset.table.toLowerCase().includes(q);
        li.hidden = !tableMatches;
        if (tableMatches) groupMatches = true;
      }
    }

    group.hidden = !groupMatches;
    if (groupMatches) {
      anyMatch = true;
      // Filter-driven expansion: keep aria-expanded and ul.hidden in lockstep,
      // same pair the click handler and highlight() already maintain.
      if (ul) ul.hidden = false;
      btn?.setAttribute("aria-expanded", "true");
    }
  }

  setNoMatchMessage(anyMatch ? null : term);
}

treeFilter.addEventListener("input", () => applyFilter(treeFilter.value));
treeFilter.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  treeFilter.value = "";
  applyFilter("");
});

async function renderBrowse(catalog, deepNs, deepTable) {
  directoryMain.hidden = true;
  viewBrowse.hidden = false;
  tree.innerHTML = "";
  treeFilter.value = ""; // filter is not URL state — reset on every tree rebuild
  noMatchEl = null;
  tree.appendChild(status("Loading namespaces…", true));

  const api = makeApi(catalog);
  let namespaces;
  try {
    ({ namespaces } = await api("/namespaces"));
  } catch (err) {
    tree.innerHTML = "";
    tree.appendChild(status(`Could not reach the catalog: ${err.message}`));
    return;
  }

  // ponytail: /namespaces returns only top-level namespaces; this app does not
  // recurse into child namespaces in v1 — add if a catalog actually nests them.
  namespaces.sort((a, b) => a.join(".").localeCompare(b.join(".")));
  // Two calls per namespace, fetched concurrently: serially this was the sum of
  // every namespace's round-trip, which is seconds of empty sidebar. The 429
  // retry in makeApi covers the burst.
  const groups = await Promise.all(
    namespaces.map((nsParts) => renderNamespaceGroup(catalog, api, nsParts, deepNs, deepTable))
  );
  tree.innerHTML = "";
  for (const group of groups) tree.appendChild(group);

  await updateTableView(catalog, deepNs, deepTable);
}

async function updateTableView(catalog, ns, table) {
  currentNs = ns;
  currentTable = table;
  highlight(ns, table);
  const tableView = document.getElementById("table-view");
  if (ns && table) {
    await renderTableDetail(tableView, catalog, ns, table);
  } else {
    tableView.innerHTML = "";
    tableView.appendChild(status("Select a table from the left to see its schema, snapshots and a copyable query."));
  }
}

async function renderNamespaceGroup(catalog, api, nsParts, deepNs, deepTable) {
  const path = nsPath(nsParts);
  const nsLabel = nsParts.join(".");
  const group = document.createElement("div");
  group.className = "ns-group";
  group.dataset.nsLabel = nsLabel; // filter match target, kept off the button text

  let nsInfo = { properties: {} };
  let tablesInfo = { identifiers: [] };
  let loadError = null;
  try {
    [nsInfo, tablesInfo] = await Promise.all([
      api(`/namespaces/${path}`),
      api(`/namespaces/${path}/tables`),
    ]);
  } catch (err) {
    loadError = err.message;
  }
  const tables = tablesInfo.identifiers.map((t) => t.name).sort((a, b) => a.localeCompare(b));

  const isDeepMatch = deepNs && deepNs.join(NS_SEP) === nsParts.join(NS_SEP);

  const btn = document.createElement("button");
  btn.className = "ns-button";
  btn.setAttribute("aria-expanded", String(isDeepMatch || false));
  const nameSpan = document.createElement("span");
  nameSpan.className = "ident";
  nameSpan.textContent = nsLabel;
  btn.appendChild(nameSpan);
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = loadError ? "error" : String(tables.length);
  btn.appendChild(count);
  group.appendChild(btn);

  if (loadError) {
    const p = document.createElement("p");
    p.className = "ns-comment";
    p.textContent = `Could not load this namespace: ${loadError}`;
    group.appendChild(p);
    return group;
  }

  if (nsInfo.properties?.comment) {
    const p = document.createElement("p");
    p.className = "ns-comment";
    p.textContent = nsInfo.properties.comment;
    group.appendChild(p);
  }

  const ul = document.createElement("ul");
  ul.className = "tables";
  ul.hidden = !isDeepMatch;
  for (const table of tables) {
    const li = document.createElement("li");
    const tbtn = document.createElement("button");
    const identSpan = document.createElement("span");
    identSpan.className = "ident";
    identSpan.textContent = table;
    tbtn.appendChild(identSpan);
    tbtn.dataset.ns = nsParts.join(NS_SEP);
    tbtn.dataset.table = table;
    tbtn.setAttribute("aria-current", String(isDeepMatch && table === deepTable));
    tbtn.addEventListener("click", () => navigate({ catalog, ns: nsParts, table }));
    li.appendChild(tbtn);
    ul.appendChild(li);
  }
  group.appendChild(ul);

  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    ul.hidden = open;
  });

  return group;
}

// Selection is derived from the route, not remembered at click time, so
// back/forward and deep links highlight the right row too — and expand the
// namespace holding it.
function highlight(ns, table) {
  const key = ns ? ns.join(NS_SEP) : null;
  for (const b of tree.querySelectorAll("ul.tables button")) {
    const on = key !== null && b.dataset.ns === key && b.dataset.table === table;
    b.setAttribute("aria-current", String(on));
    if (!on) continue;
    b.closest("ul").hidden = false;
    b.closest(".ns-group")?.querySelector(".ns-button")?.setAttribute("aria-expanded", "true");
  }
}

// ---------- render dispatch ----------

// Tracks which catalog's tree is currently on screen, so picking a different
// table in the SAME catalog only swaps the table-view pane — the tree is
// already there; updateTableView re-derives the highlight. Only an actual
// catalog switch re-fetches it.
let renderedCatalogId = null;

async function render(route) {
  renderSwitcher(route.catalog);
  if (!route.catalog) {
    renderedCatalogId = null;
    await renderDirectory();
  } else if (route.catalog.id === renderedCatalogId) {
    await updateTableView(route.catalog, route.ns, route.table);
  } else {
    renderedCatalogId = route.catalog.id;
    await renderBrowse(route.catalog, route.ns, route.table);
  }
}

// ---------- boot ----------

async function boot() {
  let base = [];
  try {
    base = await fetch("./catalogs.json").then((r) => r.json());
  } catch {
    base = []; // ponytail: missing/broken catalogs.json just yields an empty directory, not a crash
  }
  registry = [...base, ...loadCustomCatalogs()];
  await render(currentRoute());
}

boot();
