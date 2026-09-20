// The explorer (explorer/public/) is a static, build-free browser app with no
// test framework of its own. These three helpers are the parts that are subtly
// wrong if you eyeball them, so they get the one check that exists.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser JS, no types
import { parseJson, nsPath, nsLabel, sqlIdent } from "../explorer/public/util.js";

describe("parseJson", () => {
  it("keeps int64 snapshot ids exact", () => {
    // JSON.parse alone rounds this to 4875483276225980000 — an id that names
    // no snapshot at all.
    const out = parseJson('{"snapshot-id": 4875483276225980728}');
    expect(out["snapshot-id"]).toBe("4875483276225980728");
  });

  it("keeps negative ids and leaves ordinary numbers alone", () => {
    const out = parseJson('{"parent-snapshot-id": -2075757686315601479, "timestamp-ms": 1789783188130}');
    expect(out["parent-snapshot-id"]).toBe("-2075757686315601479");
    expect(out["timestamp-ms"]).toBe(1789783188130);
  });
});

describe("namespace forms", () => {
  it("joins multi-level namespaces with the unit separator for REST paths", () => {
    expect(nsPath(["a", "b"])).toBe("ab");
    expect(nsPath("a.b")).toBe("ab");
    expect(nsPath(["needs esc/aped"])).toBe("needs%20esc%2Faped");
    expect(nsLabel(["a", "b"])).toBe("a.b");
  });

  it("quotes each identifier part separately in SQL", () => {
    expect(sqlIdent(["a", "b"], "t")).toBe('"a"."b"."t"');
    expect(sqlIdent(["raw"], 'we"ird')).toBe('"raw"."we""ird"');
  });
});
