# Security Policy

icegate is an authentication gateway — security reports get priority.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use
[GitHub private vulnerability reporting](https://github.com/seandavi/icegate/security/advisories/new),
or email seandavi@gmail.com.

You can expect an acknowledgment within a week. Please include enough detail
to reproduce (config shape, request, expected vs actual behavior).

## Scope

Of particular interest: authentication or authorization bypasses (API key
handling, principal/namespace/capability enforcement), credential leakage
through proxied responses, and ways a client can reach the backend without
going through the gateway's auth (e.g. via `/v1/config` rewriting gaps).

## Supported versions

The latest release only.
