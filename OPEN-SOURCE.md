# Open and closed source

This repository is public. It uses a mixed license scheme (decided by Tainan, 2026-10-12).

- The directories in the first table are open under the **Apache License 2.0**.
  Each directory holds the full text in a `LICENSE` file and a `NOTICE` file
  ("Copyright 2026 Itera / DevFellowship"). `apps/web/src/verify.ts` is one file, so it carries
  an SPDX header instead.
- Everything else is **proprietary**: "Copyright (c) 2026 Itera / DevFellowship. All rights
  reserved. Source available for review only; no license is granted to use, copy, modify or
  distribute, except the directories listed in OPEN-SOURCE.md, which are licensed under
  Apache-2.0." See the root [`LICENSE`](LICENSE).

## Open (Apache-2.0)

| Path | What it is | Why it is open |
|---|---|---|
| `packages/contracts/` | Schemas for task, evidence, run profile and run actions. Glossary helpers and tool-environment helpers. | Anyone who writes a task or reads a proof needs the exact contract. A shared contract is more useful when it is open. |
| `apps/web/src/verify.ts` | The browser verifier. It runs 7 checks against an attestation mint, with read-only RPC and IPFS calls. | A proof is worth trusting only if anyone can read and run the code that checks it. It imports no product code. |
| `services/attestation/` | The on-chain attestation client (Solana Attestation Service). | The proof format must be auditable. Anyone can rebuild the manifest and compare it with the chain. |
| `mcp/catalog/` | The MCP fixture servers (`helpdesk`, `memory`) and their tool lists. | Task authors pin these images by digest. They need to see what the fixture does. |
| `mcp/base/` | The shared fixture base inside the catalog images. | Already published under Apache-2.0 in the catalog images (see `mcp/base/LICENSE-NOTICE`). `mcp/catalog/LICENSE` covers it. No file is added here, because a published catalog version is immutable and CI blocks changes. |
| `tools/tma-launcher/` | The `tma` launcher (npm `@devfellowship/tma`). It runs the signed, digest-pinned local runner image and says what it mounts. | A user gives this code the Docker socket of their machine. They must be able to read exactly what it runs and mounts. The image it runs stays proprietary (use license in the image). |
| `docs/architecture/` | Architecture documents (for example the MCP sandbox contract). | Design decisions are easier to trust and to review in public. |

Third-party code keeps its own license: `mcp/catalog/memory/LICENSE.upstream` and `mcp/base/LICENSE-NOTICE`.

## Closed (proprietary, source available for review only)

| Path | What it is | Why it is closed |
|---|---|---|
| `services/runner/` | Runs the agent and the grader in sandboxes. | Product logic and isolation details. |
| `services/evaluator/` | Scores a run against a task. | Product logic. Part of the grading method. |
| `services/run-issuer/` | Issues run proofs. | Product logic. |
| `apps/api/` | The TestMyAgent API. | Product logic and the business model (quotes, payments, accounts). |
| `apps/web/` (except `src/verify.ts`) | The web app. | Product UI. |
| `benchmarks/` (including hidden tests) | Benchmark tasks, solutions and hidden tests. | Hidden tests must stay out of reach of agents. See the note below. |
| `scripts/`, `db/`, `tools/` (except `tools/tma-launcher/`), `.github/` | Internal scripts, migrations, tooling and CI. | Internal operations. |

## Notes

- **Apache-2.0 grants are irrevocable for published versions.** Anyone who got a version of an
  open directory under Apache-2.0 keeps that grant for that version for good. A later change
  of license, or a move of a directory to closed, affects only later versions.
- **"Closed" is a license, not a secret.** The repository is public, so closed source is
  readable but not usable. The hidden tests in `benchmarks/` are kept apart by path, not by
  secrecy (see `benchmarks/tsk_webhook_dup/tests/hidden/README.md`). The license does not stop an
  agent from reading them.
- **Package fields.** Open packages (`@itera/contracts`, `@itera/attestation`) say
  `"license": "Apache-2.0"`. Closed packages say `"license": "UNLICENSED"`. Every workspace
  package stays `"private": true`: nothing here is published to npm.
- Open directories carry the line `SPDX-License-Identifier: Apache-2.0` in their source files.
  The exception is `mcp/`: the files there stay byte for byte as published.
- To move a path from closed to open, add `LICENSE` and `NOTICE` there and update this file
  and the root `LICENSE`.
