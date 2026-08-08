# Contributing

Keep changes small, evidence-backed, and covered by deterministic tests. Do not weaken the Task boundary: a model requests a typed capability, Conclave policy validates it, and only the structured runner may execute it.

Before opening a change, run `npm run verify`. New retrieval, reasoning, and task fixtures must declare their expected outcomes before evaluation. Never add credentials, generated `.conclave` state, or machine-specific paths.
