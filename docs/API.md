# API and Usage

CodeSentinel can be invoked three ways: as a **GitHub Action** (no server, the default),
as an **HTTP API** (a running flue server), or as a **CLI** (local / CI without the
Action). They all call the same workflows and resolve configuration the same way —
see [Configuration](./CONFIGURATION.md).

## Deployment modes

| Mode | How you invoke it | When to use it | Server? |
| --- | --- | --- | --- |
| GitHub Action (review) | `uses: ancientdev0x/CodeSentinel@v0` | Review every PR in CI — no server to operate. | No |
| GitHub Action (QA) | `uses: ancientdev0x/CodeSentinel/qa@v0` | Run autonomous QA in CI (or on-demand via `workflow_dispatch`). | No |
| Webhook channel (server) | `POST /channels/github/webhook` | Live `/CodeSentinel review` comment triggers against a live server. | Yes |
| Self-hosted server | `node dist/server.mjs` | Programmatic review/QA via HTTP without GitHub Actions. | Yes |
| Local CLI | `npx CodeSentinel review` / `npx CodeSentinel qa` | Run against your machine against staged changes. | Yes (boots a local server) |

> The Action inputs map 1:1 to the `CodeSentinel_*` environment variables documented in
> [Configuration](./CONFIGURATION.md). The payload JSON field names mirror the env vars
> (`model`, `thinkingLevel`, `reviewLanguage`, `ignore`, `customInstructions`,
> `mcpServers`, `baseSha`/`headSha`, `platform`, etc.) and take the **highest**
> precedence.

## HTTP API (server mode)

When running `node dist/server.mjs` (or `npm start`), flue serves the workflow routes
and the GitHub channel. **Authentication** for the workflow routes relies on the
secrets in the request payload/environment (`GITHUB_TOKEN`, provider keys); the webhook
channel verifies the delivery signature.

| Method | Path | Auth | Purpose | Source |
| --- | --- | --- | --- | --- |
| `POST` | `/workflows/review` | bearer env/payload | Run the review workflow once. | `src/workflows/review.ts` (exports `route`) |
| `POST` | `/workflows/review?wait=result` | bearer env/payload | Same, but blocks and returns the result (used by the CLI). | flue runtime |
| `POST` | `/workflows/qa` | bearer env/payload | Run the QA workflow once. | `src/workflows/qa.ts` |
| `POST` | `/channels/github/webhook` | `GITHUB_WEBHOOK_SECRET` | Receive GitHub Events and trigger review/QA. | `src/channels/github.ts` |
| `GET` | `/` (or any unmatched route) | — | 404 `Not found`. | flue server fallback |

A second, separate service exists for **anonymous telemetry only**:

| Method | Path | Auth | Purpose | Source |
| --- | --- | --- | --- | --- |
| `POST` | `/events` | none (intentional) | Ingest anonymous telemetry events. | `apps/server/src/index.ts` + `apps/server/src/schemas/events.ts` |

> The `/events` endpoint is unauthenticated and CORS `origin: '*'` by design (anonymous
> telemetry only — no code is sent). See [Security](../SECURITY.md#where-secrets-live-and-how-they-are-handled)
> and [Deployment](./DEPLOYMENT.md).

### Example: run a review over HTTP

```bash
curl -X POST http://127.0.0.1:3000/workflows/review?wait=result \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d '{
    "platform": "github",
    "workspace": "/path/to/checkout",
    "owner": "ancientdev0x",
    "repo": "CodeSentinel",
    "prNumber": 1,
    "baseSha": "base...",
    "headSha": "head..."
  }'
```

### `POST /events` body (telemetry)

Ingests a `TelemetryEvent` — one of (`apps/server/src/schemas/events.ts`):

- `REVIEW_STARTED` — `repo_id`, `run_id`, `args`, `system` (platform/arch/`CodeSentinel_version`/`node_version`), optional `environment`, `timestamp`.
- `REVIEW_STOPPED` — same envelope plus `result` (`success`, optional `error_message`), optional `tools_called` and `usage` (`input`/`output`/`total`), `details` (`code_language`, `lines_added`, `lines_deleted`), `duration_seconds`.
- `CONFIGURE` — an agent configuration/heartbeat event (`args`, `timestamp`).

A `z.union` of the three; anything else returns `400 Invalid event type`. Successful
ingest returns `200 { "success": true }`.

## Workflow payloads

### Review payload (`ReviewPayload`, `src/review/config.ts`)

| Field | Type | Required | Default | Resolved from env |
| --- | --- | --- | --- | --- |
| `platform` | `'github'` | 'local' | no | yes (`GITHUB_ACTIONS` → `github`) |
| `workspace` | string | no | `GITHUB_WORKSPACE` or `cwd` | `GITHUB_WORKSPACE` |
| `model` | string | no | `anthropic/claude-sonnet-4-6` | `CodeSentinel_MODEL` |
| `thinkingLevel` | enum | no | `medium` | `CodeSentinel_THINKING_LEVEL` |
| `reviewLanguage` | string | no | `English` | `CodeSentinel_REVIEW_LANGUAGE` |
| `ignore` | string[] | no | — | `CodeSentinel_IGNORE` (comma-split) |
| `customInstructions` | string | no | — | `CodeSentinel_CUSTOM_INSTRUCTIONS` |
| `telemetry` | boolean | no | `true` | `CodeSentinel_TELEMETRY` (`!"false"`) |
| `owner` / `repo` / `prNumber` | string/string/number | `github` only | — | `GITHUB_REPOSITORY` / `CodeSentinel_PR_NUMBER` |
| `baseSha` / `headSha` | string | no | event SHAs | `BASE_SHA` / `HEAD_SHA` (`GITHUB_SHA`) |
| `mcpServers` | object | no | `{}` | `CodeSentinel_MCP_SERVERS` (JSON) |

### QA payload (`QaPayload`, `src/qa/config.ts`, extends review)

| Field | Type | Default | Resolved from env |
| --- | --- | --- | --- |
| `kind` | `'web'` | 'cli' | no | `web` (`CodeSentinel_QA_KIND`) |
| `target` | string | — | URL/path under test (`CodeSentinel_QA_TARGET`) |
| `scope` | string | — | `CodeSentinel_QA_SCOPE` |
| `branch` | string | iso-week | `CodeSentinel_QA_BRANCH` |
| `chromeBin` | string | per-OS | `CHROME_BIN` |
| `viewport` | string | — | `CodeSentinel_QA_VIEWPORT` |
| `model` | string | lead = opus | `CodeSentinel_QA_MODEL` → `CodeSentinel_MODEL` |
| `driverModel` | string | sonnet | `CodeSentinel_QA_DRIVER_MODEL` → `model` |
| `thinkingLevel` | enum | `high` | `CodeSentinel_QA_THINKING_LEVEL` |

(`resolveQaConfig` reuses `resolveReviewConfig` for the shared fields; in `github` mode
it derives `GITHUB_REPOSITORY`/`GITHUB_TOKEN`. QA opens its own PRs, so unlike review it
does not take a `prNumber`.)

## CLI reference (`bin/CodeSentinel.mjs`)

The CLI boots the **prebuilt** `dist/server.mjs` on a random local port, posts the
workflow once, prints the JSON result, and exits. It requires `npm run build` (or a
reinstall) — it errors out cleanly if `dist/server.mjs` is missing.

| Command | Description |
| --- | --- |
| `CodeSentinel review` | Review the current repo (local = staged diff; CI = the PR). Reads `CodeSentinel_*` env. |
| `CodeSentinel qa` | Autonomous QA of the configured target. |
| `CodeSentinel init [--force]` | Scaffold `.github/workflows/CodeSentinel.yml`. |
| `CodeSentinel configure [--force]` | **Deprecated** alias for `init` (removed next major). |
| `CodeSentinel qa init [--force] [--cross-os]` | Scaffold `.github/workflows/CodeSentinel-qa.yml` + `e2e/.gitignore`. |
| `CodeSentinel qa fanout-init [owner/repoA,...]` | Scaffold a cross-repo fan-out workflow into the control repo (requires a GitHub App). |
| `CodeSentinel --help` | Print usage. |

`review`/`qa` detect CI via `GITHUB_ACTIONS` (`src/review/config.ts:95`). In Actions they
use the PR context; locally they review the staged diff (`git diff --cached`).

## GitHub Action interfaces

### Review action (`action.yml`)

| Input | → env var | Required | Notes |
| --- | --- | --- | --- |
| `repo_token` | `GITHUB_TOKEN` | yes | Usually `${{ secrets.GITHUB_TOKEN }}`. |
| `model` | `CodeSentinel_MODEL` | no | e.g. `anthropic/claude-sonnet-4-6`. |
| `review_language` | `CodeSentinel_REVIEW_LANGUAGE` | no | default `English`. |
| `thinking_level` | `CodeSentinel_THINKING_LEVEL` | no | default `medium`. |
| `ignore` | `CodeSentinel_IGNORE` | no | comma-separated. |
| `custom_instructions` | `CodeSentinel_CUSTOM_INSTRUCTIONS` | no | |
| `mcp_servers` | `CodeSentinel_MCP_SERVERS` | no | JSON map. See [MCP](./mcp.md). |
| `base_sha` / `head_sha` | `BASE_SHA` / `HEAD_SHA` | no | review range. |
| `pr_number` | `CodeSentinel_PR_NUMBER` | no | defaults to the event PR. |
| `telemetry` | `CodeSentinel_TELEMETRY` | no | default `true`; `false` opts out. |

Inputs are mapped via `inputs.X || env.X` so a value passed by `with:` is not clobbered by
an inherited `env:` (same pattern in `qa/action.yml`).

### QA action (`qa/action.yml`)

| Input | → env var | Required | Notes |
| --- | --- | --- | --- |
| `repo_token` | `GITHUB_TOKEN` | yes | |
| `target` | `CodeSentinel_QA_TARGET` | yes | URL/path under test. |
| `model` | `CodeSentinel_MODEL` | no | QA lead model (default `anthropic/claude-opus-4-8`). |
| `driver_model` | `CodeSentinel_QA_DRIVER_MODEL` | no | cheap "hands" tier (default `anthropic/claude-sonnet-4-6`). |
| `thinking_level` | `CodeSentinel_QA_THINKING_LEVEL` | no | default `high`. |
| `scope` | `CodeSentinel_QA_SCOPE` | no | flows/areas to prioritize. |
| `branch` | `CodeSentinel_QA_BRANCH` | no | overrides the iso-week branch. |
| `viewport` | `CodeSentinel_QA_VIEWPORT` | no | browser size. |
| `chrome_bin` | `CHROME_BIN` | no | |
| `telemetry` | `CodeSentinel_TELEMETRY` | no | default `true`. |

For the **full** Action reference (including `uses:` snippets and the on-demand
`/CodeSentinel` trigger), see [Action Options](./action-options.md), [Setup](./setup.md),
and [On-demand /CodeSentinel](./tag-CodeSentinel.md). For QA specifics see
[QA Feature Overview](./qa-features.md) and [Ambient QA](./ambient-qa.md).

## Agent tools (for custom agents)

Tools defined under `src/tools/` use **valibot** input schemas and are registered on
the agents (`src/agents/reviewer.ts`):

- `suggest_change` — `src/tools/suggest-change.ts` — posts an inline review comment at
  a file/line range (the core review output).
- `open_pull_request` — `src/tools/open-pull-request.ts` — opens a PR (used by QA).
- `run_spec` — `src/tools/run-spec.ts` — drives a CDP browser / CLI client (`e2e/cdp-client.mjs`,
  `e2e/cli-client.mjs`).
- `catalog_flows` — `src/tools/catalog-flows.ts` — enumerates candidate test flows.
- `classify_finding` — `src/tools/classify-finding.ts` — categorizes a finding.

You can extend the agents by adding tools under `src/tools/` and registering them in
`src/agents/reviewer.ts` (for review) — see [the subagent tool guide](./subagent-tool.md).
