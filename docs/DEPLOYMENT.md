# Deployment

CodeSentinel deploys in several topologies — pick the one that matches your trust zone.
Configuration is inherited from [Configuration](./CONFIGURATION.md) (same `CodeSentinel_*`
env vars / Action inputs everywhere).

## 1. GitHub Action (recommended — no server to run)

The Action runs the review/QA workflows directly in Actions. This is the default and
needs **no** server.

### Review (every PR)

Scaffold `CodeSentinel.yml` with `npx CodeSentinel init`, or copy `action.yml`:

```yaml
# .github/workflows/CodeSentinel.yml
name: CodeSentinel
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }                 # full history so the diff is correct
      - uses: ancientdev0x/CodeSentinel@v0
        with:
          repo_token: ${{ secrets.GITHUB_TOKEN }}
          model: anthropic/claude-sonnet-4-6
          thinking_level: medium
```

Required secrets: a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, or `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`) **and**
`GITHUB_TOKEN`. Full input reference: [Action Options](./action-options.md).

### QA (on every push, scheduled, or on-demand)

Scaffold `CodeSentinel-qa.yml` with `CodeSentinel qa init` (`--cross-os` adds a 3-OS
matrix), or call `qa/action.yml` directly:

```yaml
- uses: ancientdev0x/CodeSentinel/qa@v0
  with:
    repo_token: ${{ secrets.GITHUB_TOKEN }}
    target: https://your-app.example.com
    model: anthropic/claude-opus-4-8          # QA lead (default)
    driver_model: anthropic/claude-sonnet-4-6
    scope: "checkout + login"
```

QA **opens PRs** in the target repo, so enable
Settings → Actions → General → "Allow GitHub Actions to create and approve pull
requests" first (see [QA Features](./qa-features.md), [Ambient QA](./ambient-qa.md)).

### Cross-repo QA (fan-out)

`CodeSentinel qa fanout-init owner/repoA,owner/repoB` scaffolds
`CodeSentinel-qa-fanout.yml` in a **control** repo. It dispatches each target's own
`CodeSentinel-qa.yml` via a GitHub App (needs the App's private key as a secret and App
ID as a variable — the command prints the exact setup). Each target runs under its own
token; the control repo never pushes into targets. See [Cross-Repo QA](./cross-repo-qa.md).

## 2. Webhook channel (self-hosted server)

Use this when you want **live** `/CodeSentinel review` comment triggers without GitHub
Actions, or programmatic HTTP review. Build once and run a Node process:

```bash
npm install
npm run build            # flue build -> dist/server.mjs
GITHUB_TOKEN=github_xxxghp \
GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
CodeSentinel_MODEL=anthropic/claude-sonnet-4-6 \
ANTHROPIC_API_KEY=sk-xxx \
PORT=3000 node dist/server.mjs
```

Register `https://<your-host>/channels/github/webhook` as the webhook URL on the
GitHub App/installation, using **the same** `GITHUB_WEBHOOK_SECRET`. A missing secret
makes the channel fail-closed (all deliveries rejected) — see
[Security (webhook)](./../SECURITY.md#authentication-and-authorization).

> When `GITHUB_WEBHOOK_SECRET` is unset, the server generates a fresh per-process random
> secret, so signature verification always fails — deliberate, so nobody accidentally
  ships an open receiver.

## 3. Docker (QA monolith)

The Dockerfile builds a single image that runs the **QA** workflow out of the box
(`scripts/entrypoint.sh` → `node /app/bin/CodeSentinel.mjs qa`). It bundles system
Chromium + ffmpeg for CDP screencasts and runs as root with `tini` as PID 1. **No
Playwright** — the committed tests drive Chromium directly over CDP.

```bash
npm run build            # required — Dockerfile asserts dist/server.mjs exists
docker build -t CodeSentinel-qa .
docker run --rm --shm-size=1g \
  -e ANTHROPIC_API_KEY -e GITHUB_TOKEN \
  -e CodeSentinel_QA_TARGET=https://your-app.example.com \
  -v "$PWD":/work -w /work CodeSentinel-qa
```

Notes:
- `CHROME_BIN=/usr/bin/chromium` is set in the image. Local `docker run` output lands in
  the mounted repo (overridable via `CodeSentinel_QA_WORKSPACE`).
- The image is QA-oriented; to run **review** in Docker override the command, e.g.
  `... CodeSentinel-qa node /app/bin/CodeSentinel.mjs review`.
- The build runs `--ignore-scripts` (patch-package is a devDep) and then applies the
  `patches/` pi-ai transient-retry patch explicitly, **asserting** it took.
- `.dockerignore` excludes `apps`, `e2e`, `.CodeSentinel`, etc. but **not** `.env` — see
  [Security](./../SECURITY.md#recommendations) (`.env` is not tracked by git anyway).

## 4. Local CLI

```bash
npx CodeSentinel init        # scaffold .github/workflows/CodeSentinel.yml
npx CodeSentinel review      # review staged diff; writes .CodeSentinel/review/local_*.md
npx CodeSentinel qa          # autonomous QA (set CodeSentinel_QA_TARGET / CHROME_BIN)
```

Local mode reviews the **staged** diff (`git diff --cached`); stage your changes first.
The CLI boots a short-lived local server on a random port and exits when done. See
[Setup](./setup.md).

## 5. Telemetry API (Cloudflare Worker)

`apps/server` deploys to Cloudflare as the `CodeSentinel-telemetry` worker
(`wrangler.jsonc`, `main: src/index.ts`) — `POST /events`. It ingests **anonymous only**
telemetry (`src/common/telemetry.ts`; opt out with `CodeSentinel_TELEMETRY=false`).
Deploy:

```bash
cd apps/server
npx wrangler deploy
```

It is independent of the main server and needs no secrets.

## Releases

- Releases are driven by **Changesets** (`release.yml`) using OIDC trusted publishing —
  do **not** bump the version manually or commit `CHANGELOG.md`-style entries. Add a
  changeset (`npx changeset`) when you change public behavior.
- `release-docker.yml`, `release-www.yml`, and `release-apps-server.yml` publish the
  Docker image, the `CodeSentinel-www` landing page, and the telemetry worker
  respectively.

## Choosing a mode

- **Most projects:** GitHub Action (mode 1). Zero infrastructure.
- **Want `/CodeSentinel` comment triggers on main *and* a PR, no Actions:** webhook
  channel (mode 2).
- **Run the same image everywhere, byte-for-byte local == CI:** Docker (mode 3).
- **Just iterate on your machine:** local CLI (mode 4).
