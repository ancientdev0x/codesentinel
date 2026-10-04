# Troubleshooting

A runbook of observed failures and their fixes. Every item below is backed by a source
file or CI log, not a guess. If you hit something not listed, open a
[discussion](https://github.com/ancientdev0x/CodeSentinel/discussions/new/choose).

## Quick checks first

```bash
npm run check        # oxlint + oxfmt
npm run check:types  # tsc --noEmit
npm run build        # flue build -> dist/server.mjs
npm test             # vitest
```

`npm run build` is the single most common fix — the `CodeSentinel` CLI and the Docker
image both require `dist/server.mjs` and fail fast when it is missing
(`bin/CodeSentinel.mjs:223-228`, `Dockerfile:44-45`).

## Review / QA runs

### "dist/server.mjs not found"
Run `npm run build` first. The CLI checks for it and exits with a clear message
(`bin/CodeSentinel.mjs:223`).

### The diff looks wrong / empty
- Review reads `baseSha`/`headSha` (`src/review/config.ts:101-102`), defaulting to
  `BASE_SHA`/`HEAD_SHA`/`GITHUB_SHA`. In Actions you need `fetch-depth: 0`
  (`action.yml`).
- **Local mode reviews the staged diff** (`git diff --cached`); stage your changes
  first, or pass `baseSha`/`headSha` in the payload for a specific range.

### Local mode wrote nothing / "platform: local" but ran on GitHub
`GITHUB_ACTIONS` is the trigger (`src/review/config.ts:95`); if it leaks into your
shell you'll silently be in `github` mode. Run `echo $GITHUB_ACTIONS` and `unset` it for
local runs.

### Model errors / "model not found" / weak tool-calling
- Use a capable provider. `anthropic/claude-sonnet-4-6` is the safe default; small
  Cloudflare models are weak at tool-calling — prefer `@cf/openai/gpt-oss-120b`,
  `@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/zai-org/glm-5.2`
  (`docs/setup.md:125`).
- Transient errors are retried by `pi-ai` (`PI_AI_RETRY_ATTEMPTS`/`PI_AI_RETRY_BASE_MS`
  in `.env.example`). Behind a corporate proxy, raise attempts or disable retries with
  `PI_AI_DISABLE_RETRY=1`.

### Claude Code Action "untrusted checkout" warning (CodeQL)
`.github/workflows/claude.yml` is a **first-party** GitHub workflow, so the CodeQL
"untrusted code runs with `GITHUB_TOKEN`" finding is **accepted** (the workflow is part
of this repo, not an external PR). For a stricter posture, apply the same
`author_association`-allowlist + non-bot gate used by
`CodeSentinel-mention.yml`, or run Claude via the webhook channel instead.

## QA runs (browser / CDP)

### "Could not launch Chrome" / headless browser fails
- Set `CHROME_BIN` (`src/qa/config.ts:126`). On CI without system Chrome, use the
  Docker image (bundles Chromium) instead of installing Chrome by hand.
- Give Linux containers enough shared memory: the documented runs use
  `--shm-size=1g` (`Dockerfile:6`, `scripts/entrypoint.sh`).

### TLS / self-signed / corporate TLS-inspecting proxy
The CDP tests tolerate it by default (`CDP_IGNORE_CERT_ERRORS=1`). Override with
`CDP_STRICT_TLS=1` only if you want strict verification.

### Remote browser (non-local Chrome)
Point the CDP client at a separate browser daemon:
`CDP_PORT=<n>` or `CDP_WS_ENDPOINT=ws://host:port/...`; pass auth headers via `CDP_HEADERS`.
The `chrome-cdp` skill reads these (`src/skills/chrome-cdp/SKILL.md`).

### QA opened a PR on the wrong branch
QA defaults to an iso-week branch (`CodeSentinel-qa/<year>-W<week>`); override per run with
`CodeSentinel_QA_BRANCH` (`src/qa/config.ts:125`).

### QA needs to open PRs at all
QA opens PRs but **does not review an existing one** — it has no `prNumber`
(`src/qa/config.ts:63`). You still need Settings → Actions → "Allow GitHub Actions to
create and approve pull requests" in the target repo.

## On-demand `/CodeSentinel` triggers

### Comment doesn't trigger
`CodeSentinel-mention.yml` gates on **non-bot** + `author_association`
`OWNER|MEMBER|COLLABORATOR` (a fork author can't trigger it). A repo owner can still
trigger it. It also needs `pull-requests: write` + `actions` permissions.

### Want a stricter posture than the comment trigger
Use the **webhook channel** (mode 2) — it never checks out PR code, so there's no
untrusted-checkout surface. See [Security](./../SECURITY.md).

## Cross-repo QA (fan-out)

- The control workflow dispatches each target's **`CodeSentinel-qa.yml` on the default
  branch** (`bin/CodeSentinel.mjs:197-198`). If a target doesn't have that file on its
  default branch, the dispatch fails.
- The GitHub App needs `Actions: read and write` and must be installed on every target;
  the App private key is `QA_APP_PRIVATE_KEY`, the App ID is the `QA_APP_ID` variable
  (`bin/CodeSentinel.mjs:188-194`). Targets still use their own `GITHUB_TOKEN` + provider
  key.

## Local development / dependencies

### `npm install` fails on Linux where the lockfile was generated on macOS
The lockfile omits Linux-only optional deps (`@emnapi/*` etc.). CI and Docker use
`npm install` (not `npm ci`) for this reason — the lock is a reproducibility hint
(`Dockerfile:27-29`). Locally, `npm rebuild` or `npm install` again usually recovers.

### oxlint/oxfmt complain
`npm run check:fix` auto-formats and auto-lints (`package.json`). `src/skills/**` and
`apps/**` are excluded from lint (`.oxlintrc.json`).

## Telemetry

### "POST /events → 400 Invalid event type"
The only accepted events are `REVIEW_STARTED`, `REVIEW_STOPPED`, `CONFIGURE`
(`apps/server/src/schemas/events.ts:66 union`). Anything else is rejected — that is by
design. Telemetry is anonymous and never includes code; disable it with
`CodeSentinel_TELEMETRY=false`.

## Known in-progress work

From `todo.md` (not bugs to file, but current limitations):
- Large-diff handling: very large PRs are not yet compacted before resuming
  (`todo.md:21`).
- Review eval/scenario tests were removed and not yet rebuilt on the flue workflow
  (`todo.md:23`).
- A landing page and better docs are still in progress (`todo.md:24`).
- A few stale doc references to `src/app.ts` (no such file — flue auto-discovers under
  `src/`) were corrected in this documentation pass.
