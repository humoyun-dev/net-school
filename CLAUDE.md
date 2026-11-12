# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NetSchool: classroom device management and lesson control for a university/school, built on a pinned [MeshCentral](https://github.com/Ylianst/MeshCentral) as the remote-management engine. pnpm monorepo, Node 24+, pnpm 11, TypeScript (ESM, `.ts` extensions in imports, `verbatimModuleSyntax`), zod, Biome.

Docs, ADRs, plans, README files and code comments are written in **Uzbek**; commit messages are English conventional commits (`feat(companion): ...`, `fix(viewer,web): ...`, `docs(plan): ...`). Follow both conventions.

## Commands

```bash
git submodule update --init      # infra/meshcentral/upstream (needed for contract tests and some unit tests)
pnpm install
pnpm meshcentral:install         # npm deps inside the MeshCentral submodule (contract tests only)

pnpm test                        # vitest "unit" project
pnpm test:contract               # starts a real pinned MeshCentral, tests the adapter (~2 min)
pnpm test:e2e:web                # builds apps/web, headless Chromium
pnpm test:e2e:companion          # builds companion in test mode, real Electron (needs a display / xvfb)
pnpm typecheck && pnpm lint      # tsc --noEmit in every workspace; biome check .
pnpm build:api                   # apps/api/dist/{main,cli}.mjs (esbuild)
pnpm build:web
node scripts/poc/matrix.mjs      # CI check: capability matrix has no `passed` without evidence
```

Single test file / test name:

```bash
pnpm vitest run --project unit apps/api/test/commands.test.ts
pnpm vitest run --project unit -t "control lease"
```

API DB tests run on in-process PGlite by default; set `TEST_DATABASE_URL=postgres://...` to run them against real PostgreSQL (what CI does). Each test DB is created through `apps/api/test/support/db.ts`.

DB migrations: edit `apps/api/src/db/schema.ts`, then `cd apps/api && pnpm exec drizzle-kit generate`. Generated SQL in `apps/api/drizzle/` is committed and not hand-edited; something drizzle-kit can't emit (e.g. partial/expression indexes) goes in a separate hand-written migration with a comment. When adding a table, also add it to the `TABLES` reset list in `apps/api/test/support/db.ts`.

Running the hub (postgres + meshcentral + api via Docker Compose): see `infra/compose/README.md`. Companion dev/packaging: `apps/companion/README.md`.

## Architecture

Spec: `docs/architecture/NETSCHOOL_ARCHITECTURE_v1.md`. Roadmap and per-phase plans: `docs/superpowers/plans/` (roadmap file tracks the status of each sub-plan P0a…P2h). Decisions: `docs/adr/`. Read the relevant ADR before changing a subsystem.

Layers and who may know what:

- `packages/domain` — transport-independent types, ports (e.g. `DeviceManagementPort`) and permission rules (`authorize`). Must not import MeshCentral, Electron, Nest, or an SQL client.
- `packages/contracts` — versioned zod schemas shared over the wire (REST v1 DTOs, capability report). API, web, and companion all depend on these.
- `packages/meshcentral-adapter` — the **only** code that speaks the MeshCentral protocol (`control.ashx` WS client, inventory, events, scoped session principals, power actions, desktop). Nothing reads/writes MeshCentral's DB.
- `packages/session-gateway` — one-time ticket → HttpOnly gateway cookie, allow-listed HTTP/WS reverse proxy to MeshCentral, revoke. Does not know MeshCentral semantics. Runs inside the API process (port 8444 in compose).
- `packages/remote-viewer` — remote desktop viewer used by the web panel (iframe via gateway).
- `apps/api` — NestJS modular monolith (`src/modules/*`: identity, organization, devices, lessons, commands, remote-sessions, power, thumbnails, events, help-requests, audit, workers). `src/app.ts` `createApp()` wires everything; MeshCentral (`deviceManagement`) and gateway (`remote`) are injectable and optional, which is how tests run without MeshCentral (`test/support/` provides fakes and seeders). Commands use an outbox worker, `Idempotency-Key`, per-device receipts, and stable error codes (`403 scope_denied`, `409 control_busy`, `409 capability_unavailable`, `503 device_offline`). Also serves the built web panel and the `netschool-admin` CLI (`src/cli`).
- `apps/web` — teacher/IT admin panel (React + Vite, Tailwind 4, shadcn/ui-style components in `src/ui`, uz/ru/en i18n).
- `extensions/browser` — managed Chrome/Edge MV3 extension (P2c web policy): DNR rules from the policy the Companion relays through the helper's native messaging host; store-published (unlisted), no signing key in the repo.
- `apps/companion` — student-PC Electron app. `src/core` is platform-independent logic (agent loop, hub client, overlay lease, hard lock, key/lock policy, cache) and is unit-tested; `src/main` holds Electron/OS-specific code (Windows keyboard hook, registry, capture); renderer is sandboxed with contextIsolation via `src/preload`.
- `tests/contracts` — contract tests against the real pinned MeshCentral.
- `infra/meshcentral` — pin (`upstream.lock.json`), `upstream/` submodule, hardened config, Dockerfile, offline agent cache. `infra/compose` — school hub deployment.
- `docs/poc` + `scripts/poc` — OS PoC runbooks, capability matrix and verification scripts.

## Hard rules (from the roadmap / spec)

- Never edit `infra/meshcentral/upstream`; upgrade procedure is in `infra/meshcentral/README.md`. Patches would go to a separate fork.
- Never disable TLS verification (`rejectUnauthorized: false` is forbidden); companion and clients are fail-closed on TLS.
- No arbitrary shell/script execution in the teacher API.
- Every business record carries `organization_id`, and `site_id` where relevant.
- Media frames (thumbnails, screens) are never written to DB, outbox, or audit.
- No private keys in the repo; `meshcentral-data/` and compose `secrets/` are ignored.
- Central university management (power, app install/removal, OS restrictions) is mandatory, not optional; no OS is marked supported in `docs/poc/capability-matrix.md` without recorded evidence.
