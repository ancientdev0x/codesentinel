# Contributing to CodeSentinel

CodeSentinel is an extensible code-review + autonomous QA agent built on
[flue](https://github.com/withastro/flue). It is written in TypeScript, ships as a
GitHub Action, and runs on Node 22. This guide is for contributors to the
`CodeSentinel` repository itself.

> These are the conventions the repository currently enforces. They are
> documented here for convenience; the source of truth is the CI configuration
> (`.github/workflows/*.yml`) and `package.json`.

## Prerequisites

- **Node ≥ 22.19.0** (the engine requirement in `package.json`; CI uses Node 22).
- **npm** (the lockfile is `package-lock.json`; do **not** use `bun` — the project
  migrated from bun to Node/npm, see `docs/flue-migration.md`).
- **Git** (full history needed for diff computation; CI uses `fetch-depth: 0`).
- A model provider key only to run a *real* review/QA locally (e.g.
  `ANTHROPIC_API_KEY`). You do not need a key to build, lint, typecheck, or test.

## Repository layout

- `src/` — the flue project: `agents/` (reviewer, qa-lead, mention),
  `workflows/` (review, qa), `tools/`, `review/`, `qa/`, `channels/`, `common/`,
  `github/`, `mcp/`, `skills/`.
- `tests/` — Vitest specs mirroring `src/` (kept out of `src/` so the package stays
  clean).
- `apps/server` — the Cloudflare Workers telemetry API (`POST /events`).
- `apps/www` — the marketing site (Vite + React, deployed to Cloudflare).
- `bin/` — the `CodeSentinel` CLI and the scaffolded workflow templates.
- `qa/` — the CodeSentinel QA composite GitHub Action.
- `docs/` — user-facing documentation.
- `.changeset/` — Changesets config (drives releases).

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full component map.

## Setup

```bash
git clone https://github.com/ancientdev0x/CodeSentinel.git
cd CodeSentinel
npm install
```

Copy `.env.example` to `.env` and set a provider key if you want to run a real
review/QA. Local mode reviews your **staged** changes by default.

## Development commands

These are the same scripts CI runs (see `.github/workflows/pr.yml`):

| Command | What it does |
| --- | --- |
| `npm run dev` | Run flue in dev mode (`flue dev --target node`). |
| `npm run review` | Run the review workflow locally against staged changes (`flue run review --target node`). Writes to `.CodeSentinel/review/`. |
| `npm run qa` | Run the QA workflow locally (`flue run qa --target node`). |
| `npm run build` | Build the publishable Node server to `dist/server.mjs` (`flue build --target node`). |
| `npm start` | Run the built server (`node dist/server.mjs`). |
| `npm test` | Run Vitest. |
| `npm run check` | Lint with oxlint + check formatting with oxfmt. |
| `npm run check:types` | Typecheck with `tsc --noEmit`. |
| `npm run check:fix` | Auto-fix lint + format (`oxlint --fix && oxfmt`). |

## Before pushing

Run the CI gate locally first:

```bash
npm run check        # oxlint + oxfmt
npm run check:types  # tsc --noEmit
npm run build        # flue build -> dist/server.mjs
npm test
```

Then verify the built server actually boots (this catches agent-discovery errors at
boot time — the gate CI itself runs):

```bash
PORT=38271 timeout 10 node dist/server.mjs
```

A timeout (exit code `124` = ran-until-killed) means the server booted successfully;
any other non-zero code is a real boot crash.

## Coding style

- oxfmt: 2-space indent, single quotes, ES5 trailing commas, semicolons as-needed,
  line width 90 (`.oxfmtrc.json`).
- oxlint `correctness` rules as errors (`.oxlintrc.json`); `src/skills/**` and
  `apps/**` are excluded from lint.
- TypeScript strict (`tsconfig.json`); resolve `noUnusedLocals`/`noUnusedParameters`
  rather than suppressing.
- ESM (`"type": "module"`).
- Tools use **valibot** schemas (`v.object(...)`); workflows use
  `defineWorkflow({ agent, input, run })`. Flue-specific API facts are documented in
  `docs/flue-migration.md`.

## Testing

- Tests live in `tests/` and mirror the `src/` layout (`.test.ts`).
- The suite mocks the model and GitHub/network — run any test with `npm test`; no
  real API key or network access is required.
- When you add or change behavior, add/extend a test in the matching `tests/` file.

## Commits and pull requests

- **Commit style:** Conventional Commits (`feat:`, `fix:`, `chore:`, etc.). The
  `amannn/action-semantic-pull-request` workflow (`.github/workflows/check-pr-title.yml`)
  enforces this on pull-request titles.
- **Do not bump the version manually.** Releases are automated via Changesets on push
  to `main` (see `docs/flue-migration.md` Change Log). Add a changeset
  (`.changeset/*.md`) when you change public behavior — e.g.
  `npx changeset`.
- **Keep diffs minimal and scoped.** Do not commit `dist/`, `node_modules/`, or
  secrets. `.gitignore` already excludes `dist`, `.env`, and local run output.
- The `review` job in `.github/workflows/pr.yml` dogfoods CodeSentinel on its own PRs
  (non-blocking).

## CI pipeline

`.github/workflows/pr.yml` runs, in order: checkout (`fetch-depth: 0`) →
`npm install` → `npm run check` → `npm run check:types` → `npm run build` → server
boot smoke → `npm test`, followed by the non-blocking self-review job.

## Reporting issues and security

- For bugs and feature requests, open a GitHub issue. Use the issue templates under
  `.github/ISSUE_TEMPLATE/`.
- **Security vulnerabilities**: see [SECURITY.md](./SECURITY.md). Do **not** open a
  public issue for a security vulnerability.

## License

CodeSentinel is published as a GitHub Action and npm package. See the footer of
`README.md` for the license status.
