# Configuration

This is the exhaustive configuration reference for CodeSentinel. Configuration is
resolved **once, centrally** from the environment (and, for direct workflow
invocations, from the payload). Every agent, tool, and workflow resolves its values
through the same code — see `src/review/config.ts` (`resolveReviewConfig`) and
`src/qa/config.ts` (`resolveQaConfig`, which reuses the review resolver), plus
`src/common/models.ts` for model precedence.

- **Payload values win over environment variables** (so `flue run review --payload`
  overrides local `.env` / CI env).
- Model resolution is centralised in `src/common/models.ts`: `CodeSentinel_MODEL`
  configures the whole system; each role has one documented override that falls back
  to it. Nothing hardcodes a model string (`src/agents/*.ts`, `src/qa/*.ts`).
- Provider credentials are **not read by this repo's own code** — they are passed
  through to the environment so flue's model layer consumes them.

> For choosing a model and provider see [AI Provider Configuration](./ai-provider-config.md).
> For the GitHub Action inputs (the CI seam) see [Action Options](./action-options.md)
> and [Setup](./setup.md).

## Secrets vs. non-secrets

A value is **secret** if it can authenticate as you or your providers.

| Variable | Secret? | Category | Required? | Default |
| --- | --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes | Provider credential | One matching `MODEL` | — |
| `OPENAI_API_KEY` | Yes | Provider credential | One matching `MODEL` | — |
| `OPENROUTER_API_KEY` | Yes | Provider credential | One matching `MODEL` | — |
| `CLOUDFLARE_API_KEY` | Yes | Provider credential | Only for Cloudflare providers | — |
| `CLOUDFLARE_GATEWAY_ID` | Yes | Provider credential | Only for `cloudflare-ai-gateway` | — |
| `CLOUDFLARE_ACCOUNT_ID` | No | Cloudflare account | Required for Cloudflare providers | — |
| `GITHUB_TOKEN` | Yes | GitHub identity | Yes (GitHub platform) | — |
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook verification | Yes (webhook/server mode only) | — |
| `CodeSentinel_MCP_SERVERS` | Maybe (may carry `Authorization` headers) | MCP servers | No | none |

Never commit `.env`. `.gitignore` excludes `.env`; `.env.example` ships only empty
placeholders (`src/common/telemetry.ts` and `src/review/config.ts` are the only
readers — they never log these values).

## Provider credentials

Set the credential matching your chosen `MODEL` prefix (`src/common/models.ts`):

| Provider prefix | Credential env var(s) |
| --- | --- |
| `anthropic/<model>` | `ANTHROPIC_API_KEY` |
| `openai/<model>` | `OPENAI_API_KEY` |
| `openrouter/<model>` | `OPENROUTER_API_KEY` |
| `cloudflare-workers-ai/<model>` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| `cloudflare-ai-gateway/<model>` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |

The default model is `anthropic/claude-sonnet-4-6`, which needs `ANTHROPIC_API_KEY`.

## Review configuration

Resolved by `resolveReviewConfig` (`src/review/config.ts`). Defaults shown are the
code defaults, not documentation guesswork.

| Variable | Source | Default | Notes |
| --- | --- | --- | --- |
| `CodeSentinel_MODEL` | env | `anthropic/claude-sonnet-4-6` (see `src/common/models.ts`) | `provider/model` string; the whole system's default. |
| `CodeSentinel_REVIEW_LANGUAGE` | env | `English` | Language for review feedback. |
| `CodeSentinel_THINKING_LEVEL` | env | `medium` | `off \| minimal \| low \| medium \| high \| xhigh` |
| `CodeSentinel_IGNORE` | env | — | Comma-separated glob patterns; split on `,`, trimmed, empties dropped. |
| `CodeSentinel_CUSTOM_INSTRUCTIONS` | env | — | Extra instructions appended to the review prompt. |
| `CodeSentinel_MCP_SERVERS` | env/payload | `{}` | JSON map of remote MCP servers (also `payload.mcpServers`). See [MCP](./mcp.md). |
| `CodeSentinel_TELEMETRY` | env | `true` | `false` opts out of anonymous telemetry. |
| `CodeSentinel_PR_NUMBER` | env | `0` | PR number (GitHub platform only). |
| `BASE_SHA` / `HEAD_SHA` | env | PR event SHAs / `GITHUB_SHA` | Diff range. Three-dot `base...head`. |
| `platform` | payload | `github` in Actions, else `local` | `local` reviews the staged diff (`git diff --cached`). |

`GITHUB_TOKEN` is **required** when `platform === 'github'` (it builds the Octokit
client in `src/github/reporter.ts`). The workspace defaults to `GITHUB_WORKSPACE`
(env) or `cwd` (local).

## QA configuration

Resolved by `resolveQaConfig` (`src/qa/config.ts`). QA reuses the review settings
above, then adds:

| Variable | Env var | Default | Notes |
| --- | --- | --- | --- |
| Model (lead + healer) | `CodeSentinel_QA_MODEL` (→ `CodeSentinel_MODEL`) | `anthropic/claude-opus-4-8` | Judgement tier. Falls back to `CodeSentinel_MODEL`. |
| Driver model | `CodeSentinel_QA_DRIVER_MODEL` (→ `CodeSentinel_QA_MODEL` → `CodeSentinel_MODEL`) | `anthropic/claude-sonnet-4-6` | Cheap "hands" tier for drivers. |
| Thinking level | `CodeSentinel_QA_THINKING_LEVEL` | `high` | |
| Target kind | `CodeSentinel_QA_KIND` | `web` | Set to `cli` to QA a CLI/terminal product (no browser). |
| Target under test | `CodeSentinel_QA_TARGET` | none | URL/path → `E2E_BASE_URL`. Empty: the agent boots/detects the target. |
| Scope | `CodeSentinel_QA_SCOPE` | none | Free-text flows/areas to prioritize. |
| Branch override | `CodeSentinel_QA_BRANCH` | iso-week (`CodeSentinel-qa/<year>-W<week>`) | Broken-flow fixes use a per-flow branch instead. |
| Viewport (web) | `CodeSentinel_QA_VIEWPORT` | client default (1280×900) | `1280x900` · `375x812@2` · `mobile` · `tablet` · `desktop`. |
| Chrome binary | `CHROME_BIN` | OS default | macOS/Linux/Windows-specific defaults in `src/qa/config.ts`. |
| Platform | `platform` | auto | `github` in Actions, else `local`. |

## QA / CDP runtime environment

Used by the QA agent and the committed CDP/CLI test clients (`src/skills/chrome-cdp/`):

| Variable | Default | Notes |
| --- | --- | --- |
| `E2E_BASE_URL` | — | Base URL committed tests navigate against. |
| `E2E_VIEWPORT` | — | Set by the agent to `CodeSentinel_QA_VIEWPORT`. |
| `E2E_CWD` | cwd | CLI tests resolve paths against this (the target checkout). |
| `E2E_ARTIFACTS_DIR` | `e2e/.artifacts` | Screenshots + `session.mp4`. |
| `CHROME_BIN` | per-OS default | Headless Chrome the agent launches per flow. |
| `CDP_PORT` | `9222` | CDP daemon port (default 9222; `+FLOW_INDEX` offsets per driver). |
| `CDP_WS_ENDPOINT` | — | Explicit ws endpoint (remote browser seam). |
| `CDP_HEADERS` | — | Auth headers for a remote CDP endpoint. |
| `CDP_IGNORE_CERT_ERRORS` | `1` (agent + tests) | Tolerates self-signed / TLS-inspecting-proxy HTTPS. |
| `CDP_RECORD` | — | JSONL log path for record-while-driving spec authoring. |
| `CDP_STRICT_TLS` | — | Opt out of cert tolerance (rare). |

The committed tests are dependency-free (Node 22 built-in `WebSocket`); they need only
`node` + system Chrome (web) or `node` (cli). See [QA Feature Overview](./qa-features.md).

## Transient-retry tuning (pi-ai)

The `@earendil-works/pi-ai` provider (used by flue) retries transient model errors.
These tune the retry behaviour in-process (`src/common/telemetry.ts` does not read
these; they are framework-level, surfaced via `.env.example`):

| Variable | Default | Notes |
| --- | --- | --- |
| `PI_AI_RETRY_ATTEMPTS` | `4` (after first try) | More attempts for hostile-network/proxy runs. |
| `PI_AI_RETRY_BASE_MS` | `500` | Backoff base; delay ≈ `base * 3^i` + jitter. |
| `PI_AI_DISABLE_RETRY` | — | Set to `1` to disable transient retries entirely. |

## Auto-set GitHub Actions variables

These are set by GitHub Actions itself; you typically do not set them by hand
(`src/review/config.ts` and `src/qa/config.ts` read them):

| Variable | Use |
| --- | --- |
| `GITHUB_ACTIONS` | Detects Actions → sets `platform: 'github'` vs `local`. |
| `GITHUB_WORKSPACE` | Default workspace (`resolveReviewConfig`). |
| `GITHUB_REPOSITORY` | `owner/repo` for the GitHub target. |
| `GITHUB_SHA` | Head commit (fallback for diff `HEAD_SHA`). |

## Passing configuration

The same keys flow through every entry point (names are stable by design):

1. **GitHub Action inputs** (`action.yml` / `qa/action.yml`) — e.g. `MODEL`,
   `THINKING_LEVEL`, `MCP_SERVERS`. Each is mapped to a `CodeSentinel_*` env var inside
   the action (`src/review/config.ts` reads the env, not the input, directly).
2. **Environment** (`.env` locally, or `env:` in a workflow) — the `CodeSentinel_*`
   vars above.
3. **Workflow payload** (`flue run <wf> --payload '{...}'`) — highest precedence. The
   payload field names mirror the env vars (`model`, `thinkingLevel`, `customInstructions`,
   `mcpServers`, `target`, `scope`, `kind`, etc.).

See [action-options.md](./action-options.md) for the full GitHub Action input table.
