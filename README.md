# Factual investigation engine

Private country-neutral planning library; partial AM-05.03. Uses the accepted pinned Knowledge public API for exact current claim references. See docs/ARCHITECTURE.md and registry/prs.json for limits, dependencies and honest acceptance state. No case lifecycle, verified finding, sending or publication service.

Run normal npm install (Git dependencies need prepare/build), then npm run check.

## Service layer

The engine runs as a service (schema `e08_investigation`): investigations opened from a case or objective reference, question trees, competing explanations, leads, research/interview/correspondence plans, an append-only attempts log, findings with verification checklists and review, contradiction and unknown registers, closure guard, reopening, lane effort accounting and immutable investigation packages (JSON, Markdown, HTML). Discovery, evidence, processing, knowledge and correspondence are reached through ports. Full surface and status: [docs/ENGINE_API.md](docs/ENGINE_API.md).

- Use: `import { createEngine, migrate, routes } from '@accountability/factual-investigation/engine'`.
- Run: `DATABASE_URL=postgresql://… IDENTITY_PUBLIC_KEYS='{"kid":"<PEM>"}' PORT=8108 npm run serve` (standalone: no collaborator ports; port-backed steps report `unavailable`).
- Test: `TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm run check` (engine tests create and drop their own databases; they are skipped visibly when the variable is unset).

The earlier planning/effort library described above is retained and still exported.
