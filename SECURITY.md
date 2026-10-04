# Security Policy

> CodeSentinel is an **automated code-review + QA agent**. It runs arbitrary model
> calls against diffs and (for QA) drives a headless browser over the Chrome
> DevTools Protocol. It is not a product that takes direct user input, but several of
> its deployment modes are **triggerable by GitHub activity** — including comments —
> so the trust boundaries below matter.

This policy is a statement of **verified behaviour** plus **recommendations** that
are clearly labelled. It is **not** a formal SLA: there is no published incident
response window and no supported-version program.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Open a **private security advisory** on GitHub:
Settings → Security → Advisories → "New advisory".

If you cannot use that interface, start a **confidential discussion** at
<https://github.com/ancientdev0x/CodeSentinel/discussions> and state it is
security-sensitive in the first line.

The maintainer will acknowledge receipt and investigate; fixes land on `main` and are
released in the next Changesets release. There is no formal SLA or guaranteed
timeline.

## Supported versions

CodeSentinel releases via **Changesets** on push to `main` (`.github/workflows/release.yml`,
OIDC trusted publishing). There is **no** long-term-support or backport window; the
**latest published release** and **`main`** are the versions that receive fixes.

## Where secrets live and how they are handled

This is the verified secret model — **no secret is read, logged, or committed by this
repo's own code except as noted**:

- **Provider keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `CLOUDFARE_API_KEY`) are **not read in source**. They are passed through the
  environment by the composite actions (`action.yml`, `qa/action.yml`) so flue's
  model layer consumes them (`src/review/config.ts`, `src/qa/config.ts`).
- **`GITHUB_TOKEN`** is read in `src/review/config.ts:120`, `src/qa/config.ts:109`,
  and used to build Octokit clients in `src/channels/github.ts:26`,
  `src/github/reporter.ts:31`, and `src/qa/pr.ts:187`. **It is never logged.**
- **`GITHUB_WEBHOOK_SECRET`** is read only in `src/channels/github.ts:35-36`. When
  unset, the channel falls back to an **unguessable per-process random secret** so
  webhook signature verification **fails closed** (all deliveries are rejected) — a
  constant fallback would let an attacker forge deliveries.
- **`CodeSentinel_MCP_SERVERS`** (JSON, may carry `Authorization` headers) is parsed
  in `src/review/config.ts:63-83` and is **not logged**.
- **No real secrets are committed.** The only env file is `.env.example` with empty
  placeholders; `dist/` and `node_modules/` are gitignored. (Verified by scan.)

Never commit `.env`, `*.pem`, `.dev.vars`, or CI token files. `.gitignore` excludes
`.env`; add `.dev.vars*` and `*.pem` to `.dockerignore` (see Recommendations).

## Authentication and authorization

- **One-shot CI review** is authenticated by `GITHUB_TOKEN` (required action input,
  `action.yml:62`). Comments are posted as the token's actor.
- **Live `/CodeSentinel` on-demand trigger (Actions mode)** — see
  `.github/workflows/CodeSentinel-mention.yml`. This job runs with `pull-requests:
  write` and secrets, and checks out PR-head code, so it is gated on
  **non-bot + `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`**. Without that gate
  a fork author could trigger it on malicious code ("pwn request"). Keep this gate on
  any comment-triggered trigger. (CodeQL flags this as an accepted, gate-mitigated
  risk; use the webhook channel for a stricter posture, since it never checks out PR
  code.)
- **Webhook channel** — `POST /channels/github/webhook` verifies deliveries with
  `GITHUB_WEBHOOK_SECRET` (delegated to `@flue/github`). Unset secret → fails closed.
- **Telemetry server** (`apps/server/src/index.ts`) — the `POST /events` endpoint is
  **unauthenticated** and **CORS `origin: '*'`** by design (it only ingests
  anonymous telemetry). See Recommendations.

## Input validation and path safety

- Tool inputs use **valibot** schemas with constraints (e.g. `src/tools/suggest-change.ts`,
  `src/tools/open-pull-request.ts`, `src/tools/run-spec.ts`).
- **git diffs are safe to compute**: `src/review/diff.ts:32-38` validate `baseSha`/`headSha`
  against a `SAFE_REF` allowlist and run `git` via `execFile` (no shell) — no shell or
  argument injection on the diff range.
- A `CodeSentinel` PR's diff range comes from `BASE_SHA`/`HEAD_SHA` (or the GitHub event)
  and is treated as a ref, not as shell input.

### Recommendation (path confinement)
`open_pull_request` (`src/tools/open-pull-request.ts`), `suggest_change`
(`src/tools/suggest-change.ts`), and `run_spec` (`src/tools/run-spec.ts`) trust
workspace-relative paths read in `src/qa/pr.ts:120-123`. This is low-severity today
(the caller is the agent / an MCP tool, not a remote attacker), but a
misbehaving model or compromised MCP server could read outside `workspace`. A future
hardening would `realpath` each path and assert it stays under the workspace root.

## Logging and data exposure

- **No API keys/tokens/diffs/prompts are logged.** `git grep` for `console.*` across
  `src/` shows only: MCP connect failures (`src/mcp/connect.ts:33`), reporter
  fallback notices (`src/github/reporter.ts:133`), CDP client notices, and the
  telemetry worker error log.
- **Telemetry is anonymous and opt-out** (`CodeSentinel_TELEMETRY=false`,
  `src/common/telemetry.ts`). Only an anonymized repo id (sha256 of `owner/repo` or
  workspace path), platform, model, host info, and an event type are sent to
  `https://telemetry.CodeSentinel.dev/events`. No code or file contents are sent.
- **QA recordings can capture sensitive data.** The `chrome-cdp` skill records
  `fill`/`type` text and `session.mp4`/screenshots under `e2e/.artifacts/` and
  `e2e/.sessions/*.jsonl`. These are **not** all gitignored — only `e2e/.artifacts/`
  is ignored by the scaffolded `e2e/.gitignore` (`bin/CodeSentinel.mjs`). **Recommendation:**
  gitignore `e2e/.sessions/` and `e2e/report/`, and scrub typed values before recording,
  when running against production apps with credentials.

## Deployment / packaging risks

- **Docker** (`Dockerfile`): runs as **root** and launches Chrome with
  `--no-sandbox` (required in-container). `.env`, `.dev.vars*`, and `*.pem` are **not**
  in `.dockerignore` — `COPY . .` would bake them in. **Recommendation:** add
  `.env*`, `.dev.vars*`, `*.pem` to `.dockerignore`.
- The Docker entrypoint runs the **prebuilt** `dist/server.mjs` (via
  `scripts/entrypoint.sh:13` → `node /app/bin/CodeSentinel.mjs qa`), never `npx flue
  run` at runtime — this avoids the `@flue/cli` → miniflare → workerd native-binary
  issue.
- **Dependencies** use `npm install` (not `npm ci`) with `--no-audit` in CI/Docker/the
  actions because the lockfile is generated on macOS and omits Linux-only optional
  deps (`@emnapi/*`); this is a deliberate cross-platform workaround, not negligence.
  Runtime deps are pinned to `~1.0.0-beta.x`.

## Recommendations (not yet implemented)

These are hardening items, not current behaviour:

1. **Telemetry `/events`** — add auth/allow-list or rate limiting, and tighten the
   `args`/`environment` free-form fields in `apps/server/src/schemas/events.ts`.
2. **`.dockerignore`** — exclude `.env*`, `.dev.vars*`, `*.pem`.
3. **Docker** — run a non-root `USER`; prefer a Chrome sandbox wrapper when not
   containerized.
4. **QA artifacts** — gitignore `e2e/.sessions/` and `e2e/report/`; redact recorded
   `fill`/`type` input before it lands in JSONL.
5. **`claude.yml`** — any future comment-triggered workflow with secrets or
   `id-token: write` should be gated like `CodeSentinel-mention.yml` (non-bot +
  `author_association` allowlist) and scope `allowed_tools` narrowly.

## Safe configuration practices

- Keep one provider key per environment; rotate after any suspected exposure.
- In CI, map each provider credential input with `{{ inputs.X || env.X }}` so an
  unset input never clobbers a caller-provided env var (see `action.yml:84-89`).
- For the webhook channel, generate a strong `GITHUB_WEBHOOK_SECRET` (≥32 bytes) and
  register the **same** value on the GitHub webhook settings page.
- Set `CodeSentinel_TELEMETRY=false` in any environment where you do not want
  anonymous usage data leaving the network.
- QA against local/HTTP targets is proxy-immune; external HTTPS behind a
  TLS-inspecting proxy needs the cert-tolerant CDP path (`CDP_IGNORE_CERT_ERRORS=1`,
  already wired). See [Troubleshooting](./TROUBLESHOOTING.md).
