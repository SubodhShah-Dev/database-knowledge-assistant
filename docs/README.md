# Documentation

Everything you need to run, understand, extend, or deploy the Database Knowledge
Assistant. Start with the reading path for your role, then use the canonical
sources table to find the authoritative page for a topic.

## Start here

| You want to… | Read in this order |
| --- | --- |
| Run the app locally | [Quickstart](getting-started/quickstart.md) → [Local setup](getting-started/local-setup.md) → [Demo data](getting-started/demo-data.md) |
| Understand how it works | [Current state](architecture/current-state.md) → [System overview](architecture/system-overview.md) → [Request lifecycle](architecture/request-lifecycle.md) |
| Work on the API or database | [API reference](reference/api/README.md) → [Database reference](reference/databases/README.md) → [Configuration](reference/configuration.md) |
| Deploy it | [Deployment guide](guides/deployment.md) → [Configuration](reference/configuration.md) → [Security checklist](concepts/13-security-checklist.md) |
| Learn by rebuilding it | [Implementation walkthrough](history/implementation-walkthrough.md) → [Concepts](concepts/README.md) → [Roadmap](history/roadmap-and-developer-guide.md) |
| Review security or tests | [Security checklist](concepts/13-security-checklist.md) → [Testing strategy](concepts/12-testing-strategy.md) |

## Documentation map

```text
docs/
├── getting-started/     Install, run, seed, and demo
├── architecture/        Current system shape and request flow
├── guides/              Deployment and operational procedures
├── reference/           API, database, and configuration reference
├── concepts/            Self-contained deep dives and design rationale
└── history/             Phase 1 build narrative (historical)
```

- [Getting started](getting-started/README.md) — prerequisites, local setup, demo data.
- [Architecture](architecture/README.md) — authoritative current state, components, request lifecycle.
- [Guides](guides/README.md) — deployment and operations.
- [Reference](reference/README.md) — HTTP API, database schema, configuration.
- [Concepts](concepts/README.md) — 17 deep dives with prerequisites, pitfalls, and backlinks.
- [History](history/README.md) — original roadmap and implementation walkthrough.

## Canonical sources

Each topic has exactly one authoritative page. Other pages link here instead of
repeating tables.

| Topic | Canonical page |
| --- | --- |
| Current implementation facts | [Current state](architecture/current-state.md) |
| Install, run, and seed | [Quickstart](getting-started/quickstart.md) |
| Environment variables and limits | [Configuration](reference/configuration.md) |
| HTTP endpoints and SSE | [API reference](reference/api/README.md) |
| App, demo, and target database schemas | [Database reference](reference/databases/README.md) |
| Deployment | [Deployment guide](guides/deployment.md) |
| Security posture and hardening | [Security checklist](concepts/13-security-checklist.md) |
| Test strategy and lifecycle | [Testing strategy](concepts/12-testing-strategy.md) |
| Phase 1 build narrative | [History](history/README.md) |

## Conventions

- **Filenames:** kebab-case, no spaces or special characters.
- **Structure:** one `#` title per file; each section directory has a `README.md` index.
- **Links:** relative links with the `.md` extension so they work on GitHub and in editors.
- **Status:** historical pages carry a banner; current pages do not repeat superseded details.
- **Canonical content:** put facts in their canonical page and link to it from elsewhere.
- **Check before committing:** run `node scripts/check-docs-links.mjs` from the repo root.
