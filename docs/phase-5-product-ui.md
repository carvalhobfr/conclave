# Local review cockpit

The browser interface is a read-only cockpit over the same review engine used by the CLI.

```text
conclave open .
  → loopback server on 127.0.0.1
  → current repository opens automatically
  → workspace/base selection, summary, findings, impact and exact diff
  → copyable handoff for the user's coding agent
  → local review history
```

The browser never receives provider credentials or arbitrary filesystem access. `conclave open` restricts the server to the selected repository. A manually started server uses `CONCLAVE_WEB_ALLOWED_ROOT` and still binds only to loopback.

Review is deterministic and requires no provider. Ask and Investigate are optional, read-only reasoning modes and use the provider configured with `conclave init`. The cockpit cannot edit, apply a patch, run repository code, commit, push, approve, or merge.

The bundled demo uses fixed repository and reasoning fixtures. Product and DOM behavior are covered by `npm run test:web`, `tests/web-product-service.test.ts`, and `tests/validation-web.test.ts`.
