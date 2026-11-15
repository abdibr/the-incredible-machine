# AGENTS.md

Agent-facing notes for The Incredible Machine — Web Clone. Keep this terse; details live in `docs/agents/`.

## Agent skills

### Issue tracker

GitHub Issues on this repo's fork (the `origin` remote), driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default canonical triage labels, used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Branch policy

- `main` is the playable game, release-only. It carries **no `*.md` files at all** — never
  plain-merge `develop` into main yourself; the release script strips every markdown file.
- All docs (README, AGENTS, GLOSSARY, ADRs, plans, work-log, scratch) live on `develop` and
  the branches below it. Always work on `develop` or a ticket/feature branch off it — not main.
- To release develop into main:

  ```
  git fetch origin
  bash <(git show develop:scripts/merge-to-main.sh)
  ```