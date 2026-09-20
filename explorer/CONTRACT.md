# explorer — module and class contract

The explorer is four plain ES modules with no build step. Nothing type-checks
them and no bundler links them, so **the seams between these files are only as
good as this document.** Every integration bug this app has had was two
authors making reasonable, opposite assumptions about something neither of
them owned. If you change a seam, change this file in the same commit.

## Hard constraints

- No build step, no bundler, no npm dependencies, no server code.
- No external fonts or icon libraries. Decoration is inline SVG or CSS.
- The only third-party code is DuckDB-WASM, loaded from a CDN **lazily**, on a
  Query or Analyze action — never on page load.
- Read-only. The app never writes to a catalog.

## Files and what each owns

| File | Owns |
| --- | --- |
| `public/app.js` | registry, routing, directory view, sidebar tree, sidebar filter |
| `public/table.js` | the table detail view and its tabs |
| `public/duck.js` | everything DuckDB-WASM |
| `public/util.js` | the REST client and helpers shared by the above |
| `public/style.css` | all styling |
| `public/index.html` | the static shell |
| `public/catalogs.json` | the bundled catalog registry |

`util.js` imports nothing. `duck.js` and `table.js` import only `util.js`.
`app.js` imports `util.js` and `table.js`. `table.js` reaches `duck.js` only
through a lazy `import()`. Keep it acyclic.

## The catalog object

Every function that talks to a catalog takes one of these, never loose
strings:

```js
{ id, label, endpoint, warehouse, description? }
```

`endpoint` is a base URL with no `/v1` and no trailing slash. A catalog the
user typed in has `id` of `custom:<endpoint>/<warehouse>`; anything else came
from `catalogs.json`.

## Namespaces have three forms — do not improvise a fourth

This is the seam that has broken most often. The Iceberg REST API returns a
namespace as an **array of parts**. That array is what gets passed between
modules. `util.js` owns the conversions:

| Need | Use | Example |
| --- | --- | --- |
| a REST path segment | `nsPath(ns)` | `a` + U+001F + `b`, each part URI-encoded |
| something to show a human | `nsLabel(ns)` | `a.b` |
| a SQL identifier | `sqlIdent(ns, table)` | `"a"."b"."t"` — each part quoted separately |

`renderTableDetail(container, catalog, ns, table)` and the `duck.js` functions
all take `ns` as **the array**. Passing a pre-encoded path double-encodes it;
passing a dotted string breaks multi-level namespaces. Both have happened.

## int64 ids are strings

Iceberg snapshot ids exceed `Number.MAX_SAFE_INTEGER` and `JSON.parse` rounds
them silently — a displayed id would name a snapshot that does not exist. The
API client in `util.js` quotes long integer literals before parsing, so every
id arrives as a **string**. Compare them as strings; never `Number()` one.
`tests/explorer-util.test.ts` pins this.

Snapshot `summary` values are also strings (`"added-records": "1"`), and the
byte-size key is `total-files-size` in practice. Treat every metadata field as
optional and render `–` when it is missing.

## Class contract

Markup modules emit these; `style.css` styles them. **Neither side invents a
name on its own** — a class in only one of the two places is the failure mode.

| Class | Emitted by | What it is |
| --- | --- | --- |
| `.page-head` | table.js | wraps the table heading + comment |
| `.stat-row` / `.stat` / `.stat-value` / `.stat-label` | table.js | the stat tiles |
| `.kv` | table.js | key/value tables (facts, properties) |
| `.cols` | table.js, duck.js | column-ish data tables |
| `.snap-table` | table.js | the history table |
| `.badge`, `.badge.key` | table.js | inline markers |
| `.num` | table.js | a numeric cell — right-aligned, tabular figures |
| `.scroll-x` | table.js, duck.js | horizontal scroll container for a wide table |
| `.eyebrow` | app.js | the small section label above the tree |
| `.tree-filter` | app.js | the sidebar filter input |
| `.ns-group`, `.ns-button`, `.count`, `.ns-comment` | app.js | the tree |
| `.cat-grid`, `.cat-card`, `.cat-desc`, `.endpoint`, `.counts` | app.js | directory cards |
| `.custom-endpoint-form` | app.js | the custom-endpoint form |
| `.ident` | app.js, table.js | an identifier not already in `<code>` |
| `.prose-width` | index.html | the reading-width cap — see below |
| `.status`, `.warn`, `.muted`, `.card`, `.tabs`, `.copy-wrap`, `.copy-btn`, `.sql` | several | shared furniture |

## State lives in exactly one place each

- **Route state is the URL.** `?catalog=` or `?endpoint=&warehouse=`, plus
  `&ns=&table=`. `pushState` on navigation, `popstate` to read it back.
- **Selection is derived from the route**, never remembered at click time —
  that is what makes back/forward highlight correctly.
- **Tree expansion** lives on `ul.tables[hidden]` and
  `.ns-button[aria-expanded]`, which must always agree with each other.
- **Filter visibility** lives on `li[hidden]` and `.ns-group[hidden]`.
  Deliberately a different mechanism from expansion so the two cannot corrupt
  each other. The filter is not URL state and resets when the tree rebuilds.
- **Theme** lives in `localStorage` and as `data-theme` on `<html>`.

## Panels toggle with `hidden`

Tab bodies and views are shown and hidden with the `hidden` property. No CSS
rule may set `display` on an element that `hidden` controls, or the two will
fight. There is no `.is-active` class anywhere; do not add one.

## Styling rules

- Every color is a token defined in `:root` and redefined for dark. **No hex
  outside the token blocks.**
- The dark tokens appear twice — once under `prefers-color-scheme` and once
  under `[data-theme="dark"]` — so a manual override can win. They must be
  kept in sync by hand; that duplication is the cost of having no build step.
- Body text and UI labels clear 4.5:1 contrast in **both** themes. This has
  been got wrong before by picking a token value that looked fine on one
  surface; check against the darkest surface the text actually sits on.
- Identifiers are monospace; prose is not.
- No horizontal page scroll at 390px. Wide tables scroll inside `.scroll-x`.

## Headroom deliberately left

A lineage view is the expected next addition. These hold today and should
keep holding:

- The tab strip takes a fifth tab with no redesign — nothing hard-codes four.
- `.stat-row` wraps at any number of tiles.
- `.ident` is styleable as a link, so a table name can become one.
- The reading-width cap lives on `.prose-width`, not on `main`, so a
  full-bleed panel opts out by not carrying the class.

Verified by injecting a fifth tab and extra tiles in a browser, not by
inspection. If you change the layout, re-check them the same way.

## Verifying a change

There is no test framework for this app and we are not adding one. What exists:

- `node --input-type=module --check < explorer/public/<file>.js` — syntax.
- `npx vitest run tests/explorer-util.test.ts` — the pure helpers in
  `util.js` (int64 parsing, the three namespace forms).
- A real browser against a live catalog, in both themes and at 390px. The
  public anonymous catalog `https://icegate-canceronice.seandavi.workers.dev`
  (warehouse `canceronice`) is the one to use — it is the only registry entry
  whose object storage also allows browser reads, so Query and Analyze work
  there. See README.md on CORS.

Everything this app does wrong shows up in a browser within seconds and in no
other way. Load the page.
