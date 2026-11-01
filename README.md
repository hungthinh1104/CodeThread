# CodeThread

**Code Comprehension Enhancement using Visual Test Trace**

CodeThread helps a developer investigate unfamiliar TypeScript source through
Jest tests, production-code links and exact source evidence. V0 targets local
committed Git revisions, static analysis and supported NestJS patterns. Static
syntax is not proof of execution, and an assertion is not proof of a passing
test.

This first batch supplies Foundation validation/tooling and the DB-01 logical
design. It contains no database implementation, analyzer, API, UI or Gemini
integration. See `product.yaml` for scope and `docs/architecture.md` for
ownership, ERDs, invariants, query design, failure scenarios and the DB-02 gate.

## Developer setup

Use Node **24.22.2** and pnpm **12.16.1**. The compiler is TypeScript **6.0.3**;
dependencies and the lockfile are pinned. No database or Docker engine is needed
for this batch. Vitest uses Vite internally as test tooling; Vite is not the
application framework.

With the pinned tools on PATH:

```sh
pnpm install --frozen-lockfile
pnpm check
```

On Windows x64 without Node or pnpm, use the optional portable bootstrap:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pnpm.ps1 install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pnpm.ps1 check
```

The bootstrap verifies the official Node archive SHA-256 and installs pinned
pnpm under ignored `.tooling`. It changes no system installation or persistent
execution policy. It requires network access to Node's distribution site and the
npm registry. Linux/macOS users install the same pinned tools through their
usual tool manager. For example, after installing Node 24.22.2,
`npm install --global pnpm@12.16.1` installs the pinned package manager.

`pnpm check` runs formatting, lint, requirement validation, package boundaries,
build, typecheck and focused tests. Individual commands are `format:check`,
`lint`, `req:validate`, `arch:check`, `build`, `typecheck` and `test`. Run
`pnpm build` before standalone tests: tests import the packages' public compiled
entry points. Use `pnpm format` when intentionally formatting changes.

## Requirements

Each YAML file is one requirement. `requirements/schema.json` owns its shape.
Lifecycle (`proposed`, `accepted`, `deprecated`) describes product agreement,
not implementation completion. Priority (`must`, `should`, `could`) describes
product criticality, not Issue scheduling. Optional test references must point
to real tests; their existence does not establish successful execution.

```sh
pnpm req:validate
pnpm req:list
pnpm req:show CT-DB-014
pnpm --silent req:context CT-DB-014
```

All commands return JSON. Use `--silent` for agent consumption through pnpm. The
context command includes the selected requirement, dependency records, module
and canonical references; it caps dependency depth at two, records at twenty,
and total UTF-8 output at 65,536 bytes including the newline. Omissions are
explicit. It fails if the selected record and mandatory envelope cannot fit.
Errors go to stderr as JSON; invalid content or unknown IDs exit 1, usage errors
exit 2.

## Work tracking and review

No remote repository, Issues or Project are provisioned by this batch. Once a
GitHub repository is connected, enable Issues, add a Project with **Backlog →
Ready → In Progress → Review → Done**, plus Blocked and Cancelled, and add
priority, module, dependency and parent-epic fields. Use the provided Epic, Task
and Bug forms; link stable requirement IDs, blockers and PRs. Keep lifecycle in
YAML and task status in GitHub. Definition of Done includes acceptance evidence,
applicable checks, documented limitations and review. Prepared Actions workflows
must be run on the remote before claiming hosted CI success.

The authoring sources are this README, `product.yaml`, requirement YAML/schema,
`docs/architecture.md`, significant decisions and `AGENTS.md`. Keep execution
reports in review/Issue discussions; do not add competing progress documents.

## Evidence and next gate

Model/contract tests verify schema invariants, not TypeScript extraction
accuracy or comprehension effectiveness. Hand-authored DTO fixtures are labeled
as such. PostgreSQL integrity, migration, concurrency, performance and restore
evidence belong to later database work packages. Independent semantic ground
truth and a human study remain separate research milestones.

After reviewing Foundation + DB-01, explicitly approve DB-02 before creating the
database package, PostgreSQL Compose service, Drizzle schema or any migration.
