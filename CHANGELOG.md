# Changelog

All notable changes to icegate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). Design rationale and research findings live on
the [wayfinder map issues](https://github.com/seandavi/icegate/issues/1).

## [0.1.0] - 2026-08-05

First public release. A stateless edge gateway for Apache Iceberg REST
Catalogs, deployed and verified end-to-end against a live Cloudflare R2 Data
Catalog with PyIceberg and vended credentials.

### Added

- Gateway core: catalog routing (`/v1/config` + `/v1/<prefix>/*`), base-URI
  joining for backends that serve under a path (R2), `backend_warehouse`
  substitution and `backend_prefix` insertion, `/v1/config` response rewrite
  (`overrides.prefix`/`overrides.uri` set, `defaults.uri` deleted) so clients
  can never bypass the gateway (#9, #10, #2).
- Authentication and authorization: `icegate_<base62×32>` API keys stored as
  SHA-256 digests, principals with namespace grants and read/write
  permissions, anonymous access rules, per-catalog capabilities, full
  operation classification for every /v1 route (#5, #8, #19, #20).
- Single shared `forward()` transport: backend credential swap, hop-by-hop
  header stripping, 30 s timeout → 502 `ErrorModel`, redirect rewriting,
  Content-Encoding fixups; CORS ahead of auth for browser preflights (#10).
- Deployment targets: Cloudflare Workers (primary, config bundled at build),
  Node entry with Prometheus `/metrics`, Dockerfile; `scripts/deploy.sh`
  worked example (#13).
- Observability: structured JSON request logs, Prometheus counters/histogram,
  `/health` and `/ready` (#11).
- Acceptance suite: 32/32 SPEC §19 checks with real PyIceberg and DuckDB
  against a containerized catalog; 0.40 ms median gateway overhead (#12).
- Documentation: README, user guide, operator guide, developer guide,
  SPEC.md as design source of truth (#26–#30).
- Community files: Apache-2.0 LICENSE + NOTICE, CONTRIBUTING, Code of
  Conduct, SECURITY, CITATION.cff, issue templates (#16, #25).

### Known issues

- StarRocks cannot read data files through vended credentials against
  S3-compatible stores ([#23](https://github.com/seandavi/icegate/issues/23),
  upstream [StarRocks#77365](https://github.com/StarRocks/starrocks/issues/77365));
  workaround documented in the user guide.
- `server.host`/`server.port` in config are validated but unread; the Node
  entry binds from `PORT` (SPEC §6 note).

[0.1.0]: https://github.com/seandavi/icegate/releases/tag/v0.1.0
